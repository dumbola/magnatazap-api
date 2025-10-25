// requestContext.js
const { v4: uuid } = require('uuid');
const onFinished = require('on-finished');

function maskPhone(raw) {
  if (!raw) return undefined;
  const s = String(raw).replace(/\D/g, '');
  if (s.length <= 4) return '***';
  return s.slice(0, 2) + '****' + s.slice(-2);
}

module.exports = function requestContext(logger) {
  return function (req, res, next) {
    req.id = req.headers['x-request-id'] || uuid();
    req.startTime = process.hrtime.bigint();

    req.log = logger.child({
      reqId: req.id,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      method: req.method,
      path: req.originalUrl || req.url,
      ua: req.headers['user-agent']
    });

    // log de entrada com payload (mascarado)
    const bodyPreview = (() => {
      try {
        const b = req.body || {};
        return {
          instanceName: b.instanceName,
          phone_masked: maskPhone(b.phone),
        };
      } catch { return undefined; }
    })();

    req.log.debug({ body: bodyPreview, headers_pick: {
      origin: req.headers.origin, apikey: !!req.headers.apikey, 'x-api-key': !!req.headers['x-api-key']
    }}, 'request_in');

    onFinished(res, () => {
      const durMs = Number((process.hrtime.bigint() - req.startTime) / 1000000n);
      req.log.info({ statusCode: res.statusCode, durMs }, 'request_out');
    });

    res.setHeader('X-Request-Id', req.id);
    next();
  };
};
