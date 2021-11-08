const EventEmitter = require('events').EventEmitter;
const MITMProxy = require('http-mitm-proxy');
const WebSocket = require('ws');
const Readable = require('stream').Readable;
const decompress = require('./utils/decompress');
const createDebug = require('./utils/createDebug');
const InterceptorFactory = require('./proxy/InterceptorFactory');
const Connection = require('./proxy/Connection');
const copyHeaders = require('./utils/copyHeaders');
const buildInPlugins = [require('./proxy/plugins/crtfile')];

const logger = require('./utils/logger');
const {truncate} = require('./utils');

const debug = createDebug('proxyserver');

const DEFAULT_CHUNK_COLLECT_THRESHOLD = 20 * 1024 * 1024; // about 20 mb
class CommonReadableStream extends Readable {
    constructor(config) {
        super({
            highWaterMark: DEFAULT_CHUNK_COLLECT_THRESHOLD * 5
        });
    }
    _read(size) {}
}

// TODO 增加精细化拦截配置项 blocking
class ProxyServer extends EventEmitter {
    constructor(options = {}, serverInstance) {
        super();
        options = typeof options === 'object' ? options : {};
        this.serverInstance = serverInstance;
        this.address = serverInstance.getAddress();
        this.options = options;
        // TODO 增加blocking实现
        this.blockingFilter = options.blockingFilter;
        // TODO forward配置
        this.forward = options.forward;

        this.port = options.port || 8002;
        // 统一sslCaDir
        this.sslCaDir = serverInstance.ca.baseCAFolder;
        this.caFilePath = serverInstance.ca.caFilePath;

        this.plugins = options.plugins || [];
        this._connectionMap = new Map();
        // 是否阻塞
        this._blocking = true;
        const proxy = new MITMProxy();
        this.proxy = proxy;

        this._addBuiltInMiddleware();

        const interceptors = {};
        ['request', 'response', 'websocket'].forEach(name => {
            interceptors[name] = new InterceptorFactory();
        });
        this.interceptors = interceptors;
        const plugins = [...buildInPlugins];
        if (Array.isArray(this.plugins)) {
            plugins.push(...this.plugins);
        }
        // 绑定plugins
        this.addPlugin(plugins);
        // ERROR 测试用，删除我
        // this.addPlugin(require('./proxy/plugins/injectBackend'));
    }
    addPlugin(plugin) {
        if (Array.isArray(plugin)) {
            // 返回intercepor remove方法，用于删除
            return plugin.map(p => this.addPlugin(p));
        }
        return plugin(this.interceptors, this);
    }
    async _runInterceptor(name, params, conn) {
        const filter = conn.getInterceptorFilter();
        if (this.interceptors[name] && filter && conn.request) {
            debug(`interceptor: ${name}`);
            await this.interceptors[name].run(params, filter.bind(conn));
        }
    }
    _addConnection(conn) {
        this._connectionMap.set(conn.getId(), conn);
    }
    _removeConnection(conn) {
        process.nextTick(() => {
            conn.close();
            this._connectionMap.delete(conn.id);
        });
    }
    stopBlocking() {
        this._blocking = false;
    }
    startBlocking() {
        this._blocking = true;
    }
    setBlocking(blocking) {
        this._blocking = !!blocking;
    }
    getBlocking() {
        return this._blocking;
    }
    isBlockable(conn) {
        if (conn && this._blocking === false) {
            return conn.isBlockable();
        }
        return this._blocking === true;
    }
    _onWebSocketConnection(ctx, callback) {
        const conn = new Connection(
            ctx.clientToProxyWebSocket.upgradeReq,
            ctx.clientToProxyWebSocket,
            ctx.isSSL,
            true,
            this
        );
        ctx.id = conn.getId();
        debug('websocket:connect', `${ctx.id},${ctx.clientToProxyWebSocket.upgradeReq.url}`);
        this._addConnection(conn);
        if (!this.isBlockable(conn)) {
            return callback();
        }
        this.emit('webSocketCreated', conn);
        callback();
    }
    // The function that gets called for each WebSocket frame exchanged.
    async _onWebSocketFrame(ctx, type, fromServer, data, flags, callback) {
        const conn = this._connectionMap.get(ctx.id);
        if (!this.isBlockable(conn)) {
            return callback(null, data, flags);
        }

        debug(
            'WEBSOCKET FRAME ' + type + ' received from ' + (fromServer ? 'server' : 'client'),
            ctx.clientToProxyWebSocket.upgradeReq.url,
            ctx.clientToProxyWebSocket.readyState,
            truncate(data, 50)
        );
        const r = {
            type, // message/ping/pong
            fromServer,
            get body() {
                return data;
            },
            set body(value) {
                data = value;
            }
        };
        if (ctx.clientToProxyWebSocket.readyState === WebSocket.OPEN) {
            debug('websocket is ready');
            await this._runInterceptor('websocket', {request: conn.request, websocket: r}, conn);
        }
        if (type === 'message') {
            fromServer ? this.emit('webSocketFrameReceived', conn, r) : this.emit('webSocketFrameSent', conn, r);
        }

        return callback(null, data, flags);
    }
    async _onWebSocketError(ctx, error) {
        const conn = this._connectionMap.get(ctx.id);
        if (!this.isBlockable(conn)) {
            return;
        }
        // TODO 错误处理
        // this.emit('error', {
        //     id: ctx.id,
        //     conn,
        //     who: 'websocket',
        //     error
        // });
    }
    _onWebSocketClose(ctx, code, message, callback) {
        const conn = this._connectionMap.get(ctx.id);
        debug('websocket:close', `${ctx.id},${ctx.clientToProxyWebSocket.upgradeReq.url}`);

        if (!this.isBlockable(conn)) {
            return callback(null, code, message);
        }
        callback(null, code, message);
        this.emit('webSocketClosed', conn);
        this._removeConnection(conn);
    }
    async _onRequest(ctx, callback) {
        const req = ctx.clientToProxyRequest;
        const clientRes = ctx.proxyToClientResponse;
        const conn = new Connection(req, clientRes, ctx.isSSL, false, this);
        ctx.id = conn.getId();
        this._addConnection(conn);
        debug('onrequest', `${ctx.id},${req.url}`);

        if (!this.isBlockable(conn)) {
            return callback();
        }

        // 压缩中间件
        // ctx.use(MITMProxy.gunzip);
        ctx.use(MITMProxy.wildcard);
        const {request, response} = conn;
        // 拦截器：用于修改发送server的请求参数
        await this._runInterceptor('request', {request, response}, conn);

        // 处理proxyToServerRequestOptions
        Object.keys(ctx.proxyToServerRequestOptions).forEach(k => {
            ctx.proxyToServerRequestOptions[k] = request[k] || ctx.proxyToServerRequestOptions[k];
        });
        if (request.headers && request.headers.host && request.headers.host !== ctx.proxyToServerRequestOptions.host) {
            request.headers.host = ctx.proxyToServerRequestOptions.host;
        }

        this.emit('requestWillBeSent', conn);

        // 处理 res.end 提前触发的情况
        if (response.finished) {
            debug('提前结束，自己修改了res');
            return;
        }
        // 监听request body
        let reqChunks = [];
        ctx.onRequestData((ctx, chunk, callback) => {
            reqChunks.push(chunk);
            return callback(null, chunk);
        });
        ctx.onRequestEnd((ctx, callback) => {
            request.body = Buffer.concat(reqChunks);
            return callback();
        });

        callback();
    }
    _onResponse(ctx, callback) {
        const conn = this._connectionMap.get(ctx.id);
        if (!this.isBlockable(conn)) {
            return callback();
        }
        const serverRes = ctx.serverToProxyResponse;
        conn.response.headers = copyHeaders(serverRes.headers);
        conn.response.statusCode = serverRes.statusCode;
        conn.response.statusMessage = serverRes.statusMessage;

        conn.markTiming('responseReceived');
        this.emit('responseReceived', conn);
        callback();
    }
    // 在发送给clinet response之前调用
    async _onResponseHeaders(ctx, callback) {
        const conn = this._connectionMap.get(ctx.id);

        if (!this.isBlockable(conn)) {
            return callback();
        }

        const originalUrl = ctx.clientToProxyRequest.url;
        debug('onrequest', `${ctx.id},${originalUrl}`);

        const serverRes = ctx.serverToProxyResponse;
        const clientRes = ctx.proxyToClientResponse;

        let resChunks = [];
        let resDataStream = null;
        let resSize = 0;
        const self = this;
        async function finished() {
            conn.response.headers = copyHeaders(serverRes.headers);
            conn.response.statusCode = serverRes.statusCode;
            conn.response.statusMessage = serverRes.statusMessage;
            if (!resDataStream) {
                debug('body stringify', originalUrl);
                let body = Buffer.concat(resChunks);
                body = await decompress(body, serverRes).catch(err => {
                    // TODO 错误处理
                    logger.error(err);
                });
                if (!body) {
                    debug('response body is empty');
                    return clientRes.end('response is empty');
                }

                // rewrite
                conn.response.body = body;

                const {request, response} = conn;

                await self._runInterceptor('response', {request, response}, conn);

                const headers = response.headers;
                const transferEncoding = headers['transfer-encoding'] || headers['Transfer-Encoding'] || '';

                // 处理chunked 情况
                if (transferEncoding !== 'chunked') {
                    headers['content-length'] = Buffer.byteLength(body, 'utf8');
                    delete headers['content-length'];
                }

                clientRes.writeHead(response.statusCode, headers);
                self.emit('loadingFinished', conn);

                clientRes.end(response.body);
            } else {
                debug('body is big stream', originalUrl);
                conn.response.body = resDataStream;
                const {request, response} = conn;

                await self._runInterceptor('response', {request, response}, conn);

                clientRes.writeHead(response.statusCode, response.headers);
                self.emit('loadingFinished', conn);
                response.body.pipe(clientRes);
            }
            self._removeConnection(conn);
        }
        serverRes.on('data', async chunk => {
            // resChunks.push(chunk);
            conn.dataReceived(chunk);
            this.emit('dataReceived', conn, chunk);
            debug('responseData', `${ctx.id},${originalUrl}`);

            if (resDataStream) {
                // stream mode
                resDataStream.push(chunk);
            } else {
                // dataChunks
                resSize += chunk.length;
                resChunks.push(chunk);

                if (resSize >= DEFAULT_CHUNK_COLLECT_THRESHOLD) {
                    resDataStream = new CommonReadableStream();
                    while (resChunks.length) {
                        resDataStream.push(resChunks.shift());
                    }
                    resChunks = null;
                    await finished();
                }
            }
        });

        serverRes.on('end', async () => {
            conn.markTiming('responseFinished');
            debug('responseEnd', `${ctx.id},${originalUrl}`);

            if (resDataStream) {
                resDataStream.push(null); // indicate the stream is end
            } else {
                await finished();
            }
        });
        serverRes.on('error', error => {
            this.emit('error', {
                who: 'serverResponse',
                error,
                conn
            });
        });
        // 继续
        return serverRes.resume();
    }
    async _onError(ctx, err, errorKind) {
        if (ctx) {
            const conn = this._connectionMap.get(ctx.id);
            if (!this.isBlockable(conn)) {
                return;
            }
            const req = ctx.clientToProxyRequest;
            const res = ctx.proxyToClientResponse;
            if (!req && !res) {
                throw err; // "Error: Must provide a proper URL as target"
            }
            const code = err.code;

            if (res.writeHead && !res.headersSent) {
                if (/HPE_INVALID/.test(code)) {
                    res.writeHead(502);
                } else {
                    switch (code) {
                        case 'ECONNRESET':
                        case 'ENOTFOUND':
                        case 'ECONNREFUSED':
                        case 'ETIMEDOUT':
                            res.writeHead(504);
                            break;
                        default:
                            res.writeHead(500);
                    }
                }
            }
            const msg =
                `Error occured while trying to proxy: ${req.url}` + errorKind ? `, error message: ${errorKind}` : '';
            res.end(msg);
        } else {
            // TODO 未知错误处理
        }
    }

    close() {
        this.proxy.close();
        for (const conn of this._connectionMap.values()) {
            conn.destroy();
        }

        this._connectionMap.clear();
        this.removeAllListeners();
    }
    listen(port) {
        port = port || this.port;
        this.proxy.listen({port, sslCaDir: this.sslCaDir});
        // logger.info(`Proxy Server Available On Port: ${port}`);
    }
    _addBuiltInMiddleware() {
        const lifeCycle = {};
        [
            'Error',
            'CertificateRequired',
            'CertificateMissing',
            'WebSocketConnection',
            'ResponseHeaders',
            'WebSocketSend',
            'WebSocketMessage',
            'WebSocketClose',
            'WebSocketError',
            'WebSocketFrame',

            'Request',
            'RequestHeaders',
            'RequestEnd',
            'Response',
            'RequestData',
            'ResponseData',
            'ResponseEnd'
        ].forEach(event => {
            if (typeof this[`_on${event}`] === 'function') {
                lifeCycle[`on${event}`] = this[`_on${event}`].bind(this);
            }
        });

        this.proxy.use(lifeCycle);
    }
}

module.exports = ProxyServer;
