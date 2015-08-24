var restify = require('restify');
var assert = require('assert');
var url = require('url');
var bunyan = require('bunyan');

var cfg = {
    slackUrl: url.parse(process.env.SLACK_URL),
    registrySelfSigned: String(process.env.REGISTRY_SELF_SIGNED).toLowerCase() == 'true',
    slackChannel: null,
    slackUser: 'docker-registry',
    slackIcon: ':whale:',
    logLevel: 'info'
};
if(/^#[\w\-]+$/.test(process.env.SLACK_CHANNEL)) cfg.slackChannel = process.env.SLACK_CHANNEL;
if(typeof process.env.SLACK_USER === 'string' && process.env.SLACK_USER.length > 0) cfg.slackUser = process.env.SLACK_USER;
if(typeof process.env.SLACK_ICON === 'string' && process.env.SLACK_ICON.length > 0) cfg.slackIcon = process.env.SLACK_ICON;
if(/^(fatal|error|warn|info|debug|trace)$/.test(process.env.LOG_LEVEL)) cfg.logLevel = process.env.LOG_LEVEL;

var log = bunyan.createLogger({
    name: "dorslag",
    streams: [{
        stream: process.stdout,
        level: cfg.logLevel
    }]
});

log.info("config: " + JSON.stringify(cfg));

process.on('uncaughtException', function (err) {
    log.error(err)
    process.exit(1)
})

function getUrlBase(url) {
    var base = url.protocol + (url.slashes ? '//' : '') + url.host + '/';
    log.debug("base for url: " + JSON.stringify(url) + " is: " + base);
    return base;
}

var slackClient = restify.createJsonClient({
    url: getUrlBase(cfg.slackUrl),
    version: '*',
    log: log
});

function relayRegistryNotification(req, res, next) {
    log.debug("type: " + req.contentType());
    log.debug("size: " + req.contentLength());
    log.debug("body: " + JSON.stringify(req.body));
    if(req.body.events && Array.isArray(req.body.events)) {
        req.body.events.forEach(handleRegistryEvent);
    } else {
        log.info("event array not found");
    }
    res.code = 200;
    res.end();
    return next();
}

function handleRegistryEvent(event, idx, events) {
    if(event.action != 'push') {
        log.debug("ignoring event: " + event.id + " with action: " + event.action);
        return;
    }
    if(event.target.mediaType != 'application/vnd.docker.distribution.manifest.v1+json') {
        log.debug("ignoring event: " + event.id + " with media type: " + event.target.mediaType);
        return;
    }
    log.debug("event for manifest push: " + event.target.url);

    var manifestUrl = url.parse(event.target.url);
    var registryClient = restify.createJsonClient({
        url: getUrlBase(manifestUrl),
        version: '*',
        log: log,
        rejectUnauthorized: !cfg.registrySelfSigned
    });
    log.debug("requesting manifest from: " + manifestUrl.href);
    registryClient.get(manifestUrl.path, function (err, req, res, manifest) {
        log.debug("manifest request error: " + JSON.stringify(err));
        assert.ifError(err);
        log.debug("retrieved manifest: " + JSON.stringify(manifest))

        var slackMessage = {
            username: cfg.slackUser,
            text: event.request.method + ' <' + event.target.url + '|' + event.request.host + '/' + manifest.name + ':' + manifest.tag + '> ' + event.target.digest,
            icon_emoji: cfg.slackIcon
        };
        if(cfg.slackChannel) slackMessage.channel = cfg.slackChannel;
        log.debug("posting message to slack: " + JSON.stringify(slackMessage))
        slackClient.post(cfg.slackUrl.path, slackMessage, slackResponse);
    });
}

function slackResponse(err, req, res, obj) {
    log.debug("slack request error: " + JSON.stringify(err));
    assert.ifError(err);
}

var server = restify.createServer({ log: log });

server.get('/ping', function(req, res, next) { res.send("pong"); return next(); } );

// jsonBodyParser only accepts one content type
server.use(function(req, res, next) {
    if(typeof req.headers['content-type'] === 'string' && req.headers['content-type'] == 'application/vnd.docker.distribution.events.v1+json') {
        req.headers['content-type'] = 'application/json';
    }
    next();
});
server.use(restify.jsonBodyParser());
server.post("/docker/registry/notification", relayRegistryNotification);

server.listen(8080, function() {
    log.info('%s listening at %s', server.name, server.url);
});
