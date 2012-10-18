var http = require('http');
var https = require('https');
var URL = require('url');
var fs = require('fs');
var util = require('util');
var IO = require('./IO.js');

IO.WebServer = function (port, wsOptions) {
    var Ex = IO.Ex;
    var WS = Object.create(Ex);
    var routes = {};
    var requestID = 0;
    var logger = null;
    var createServer = (wsOptions && wsOptions.key && wsOptions.cert) 
        ? (function (handler) { return https.createServer(wsOptions, handler); })
        : (function (handler) { return http.createServer(handler); });

    //////////////////////////////////////////////////////
    // Main interface

    // Adds a new route that connects a path to the given action.
    // You can add a common handler for all "sub routes" by using
    // a path that ends in '/'. In that case, if you have a route
    // handler for "/a/b/" and you get a url request for "/a/b/hello",
    // your handler for "/a/b/" will be used if an explicit route 
    // doesn't exist for "/a/b/hello".
    WS.route = function route_(path, action, recursive) {
        if (action) {
            routes[path] = mkRoute(action, path, path, recursive);
        } else {
            delete routes[path];
        }
    };

    // An action that serves the given file. options is
    // an object through which you can provide the following
    // choices -
    //
    // mime_type: Give the mime type if you already know it.
    // encoding: Give the encoding if you already know it. Text is 
    //           assumed 'utf8' if you don't provide it.
    // end: Boolean that indicates you want to write more data
    //       to the response stream when it is set to true. If
    //       set to false, the response stream is not passed further
    //       down the action chain.
    WS.serveFile = function (path, options) {
        var mimeType = guessMimeType(path, options ? options.mime_type : false);
        var encoding = guessEncoding(mimeType, options ? options.encoding : false);

        return function serveFile_(M, conn, success, failure) {
            if (mimeType) {
                conn.response.writeHead(200, {'Content-Type': mimeType});
            }
            var reader = fs.createReadStream(path, encoding ? {encoding: encoding} : {});
            reader.addListener('end', function () {
                M.call(success, conn, M.drain, failure);
            });
            reader.pipe(conn.response, {end: false});
        };
    };


    // Serves any file under the dir. Guesses mime type.
    // The route has to be a dir path. Written as a 
    // dynamic action that reuses WS.serveFile.
    WS.serveDir = function (dir) {
        return function serveDir_(M, conn, success, failure) {
            console.assert(conn.request.url.pathname.indexOf(conn.route.path) === 0, "The url must have the route path as a prefix string.");
            var fragment = conn.request.url.pathname.substr(conn.route.path.length);
            var action = WS.serveFile(dir + fragment);
            M.call(action, conn, success, failure);
        };
    };


    // Maps all suburls to corresponding paths in the given urlroot.
    // It simply pipes the result to the client and doesn't do any rewriting.
    WS.serveURL = function (urlroot) {
        var urlp = URL.parse(urlroot);
        return function serveURL_(M, conn, success, failure) {
            var actualPath;
            if (/\/$/.test(urlp.pathname)) {
                actualPath = urlp.pathname + conn.request.url.pathname.substr(conn.route.path.length);
            } else {
                actualPath = urlp.pathname;
            }
            var spec = {
                hostname: urlp.hostname
                , port: parseInt(urlp.port)
                , path: actualPath
            };
            http.request(spec
                    , function (res) {
                        var mime = guessMimeType(spec.path);
                        var headers = res.headers;
                        if (mime) {
                            // Override the mime type provided by fossil 
                            // using what we know. Fossil doesn't yet know
                            // some types like ".mdown" for markdown.
                            headers['Content-Type'] = mime;
                        }

                        conn.response.writeHead(res.statusCode, headers);
                        res.addListener('end', function () {
                            M.call(success, conn, M.drain, failure);
                        });
                        res.pipe(conn.response, {end: false});
                    }).on('error', function (e) {
                        M.call(IO.raise(e), conn, M.drain, failure);
                    }).end();
        };
    };

    // Begins a HTML response page.
    WS.page = function (a) {
        var action = IO.do((a instanceof Array) ? a : [].slice.call(arguments, 0));
        return function page_(W, conn, succ, fail) {
            conn.response.writeHead(200, {'Content-Type': 'text/html'});
            W.call(action, conn, W.drain, fail);
        };
    };

    // simple wrapper to write out stuff.
    // func = string
    // func = function (W, conn)
    WS.write = function (func) {
        if (typeof func === 'function') {
            return function (W, conn, succ, fail) {
                conn.response.write(func(W, conn));
                W.call(succ, conn, W.end, fail);
            };
        } else {
            return function (conn) {
                conn.response.write(func);
                return conn;
            };
        }
    };

  
    // Action that causes the current session to timeout after
    // the given value. If any actions are in progress when the
    // session expires, the next step will fail with 
    //      err.error === "session_expired"
    // When a session expires, all the dynamic links will become
    // invalid. Passing false will cancel the currently active
    // timeout.
    WS.expire = function (timeout_secs, onexpired) {
        onexpired = onexpired || sessionExpiredError;

        return function expire_(W, conn, succ, fail) {
            // Clear the previous timeout if any.
            if (W._timeout) {
                clearTimeout(W._timeout);
                W._timeout = null;
            }
            
            if (timeout_secs) {
                // Start the timer.
                var expireW = function () {
                    var i, N;
                    for (i = 0, N = W._dynlinks.length; i < N; ++i) {
                        delete routes[W._dynlinks[i]];
                    }
                    W._dynlinks.splice(0, W._dynlinks.length);
                    W._expired = onexpired;
                };

                W._timeout = setTimeout(expireW, Math.ceil(timeout_secs) * 1000);
            }

            // Continue on.
            W.call(succ, conn, W.drain, fail);
        };
    };

    // Do nothing for logging by default. The user can set a logging
    // action to take. The request object (sanitized) is sent to the logger.
    // The logging action will be done atomically, so that
    // any file writes don't get messed up. So you can do
    // proper asynchronous logging.
    WS.__defineGetter__("logger", function () {
        return logger;
    });
    WS.__defineSetter__("logger", function (logAction) {
        // automatically wrap it in atomic.
        return logger = IO.atomic(logAction);
    });
    
    // An action that wraps up all response sending.
    WS.drain = wsdrain;
    WS.end = function end_(W, conn, succ, fail) {
        conn.response.end();
        delete conn.response;
        W.call(succ, conn, wsdrain, fail);
    };
    
    // Starts the server.
    WS.start = function start_() {
        prepareWSIO();
        server.listen(port);
    };

    ///////////////////////////////////////////////////////////////////////////
    // Implementation

    // Makes a "route" structure. The "path" is the path that is being routed to the
    // given action, and "root_url" is the url based on which dynamic links must
    // be generated.
    function mkRoute(action, path, root_url, recursive) {
        return {action: action
                , path: path
                , root_url: root_url || path
                , visited: 0
                , time_stamp: new Date()
                , recursive: recursive};
    }

    // Parses an URI encoded string of the form "key1=value1&key2=value2&..."
    // into an object.
    function splitFields(str) {
        var kvpairs = {};
        if (!str) { return kvpairs; }
        str.split('&').forEach(function (kv) {
                    var kvarr = kv.split("=");
                    if (kvarr.length > 1) { 
                        kvpairs[kvarr[0]] = decodeURIComponent(kvarr[1].replace(/\+/g,'%20'));
                    } else if (kvarr.length > 0) {
                        kvpairs[kvarr[0]] = true;
                    }
                });
        return kvpairs;
    }

    // Concatenates the given array of Buffer objects into
    // a single buffer.
    function concatBuffers(bufs) {
        var i, N, bytes;
        for (i = 0, N  = bufs.length, bytes = 0; i < N; ++i) {
            bytes += bufs[i].length;
        }
        var result = new Buffer(bytes);
        for (i = 0, bytes = 0; i < N; ++i) {
            bufs[i].copy(result, bytes);
            bytes += bufs[i].length;
        }
        return result;
    }

    function runRouteAction(arg, route) {
        wsrun(arg, logger ? IO.do(route.action, requestCompleted(id)) : route.action);
    }

    // Simple support for GET and POST requests.
    var methods = {
        'GET': function (id, request, response, route) {
            var data = splitFields(request.url.query);
            runRouteAction({id: id, route: route, request: request, response: response, data: data}, route);
        },

        'POST': function (id, request, response, route) {
            request.content = [];
            request.addListener('data', function (chunk) {
                request.content.push(chunk);
            });
            request.addListener('end', function () {
                // Process post message body.
                var b = concatBuffers(request.content);
                var arg = {id: id, route: route, request: request, response: response, raw_data: b};
                
                // Make post message field parsing on demand, but easy to use.
                var parsedFields;
                arg.__defineGetter__("data", function () {
                    return parsedFields || (parsedFields = splitFields(b.toString('utf8')));
                });

                runRouteAction(arg, route);
            });
        },

        'default': function (id, request, response, route) {
            runRouteAction({id: id, route: route, request: request, response: response}, route);
        }
    };

    // Find a route handler, searching a hierarchy if necessary.
    // You can have top-level routes like "/a/b/" that end in
    // a "/" that provide a handler for all child routes.
    function findRoute(pathname) {
        var route = routes[pathname];
        if (route) { 
            return route; 
        }

        var lastComponent;
        var reLC = /[^\/]*\/?$/; // Matches the last path component.
        while (!route) {
            lastComponent = pathname.match(reLC);
            if (lastComponent.index > 0) {
                // Strip away the last component and try again.
                // Note that the new pathname now ends in a '/',
                // which we use as a signal to indicate routes 
                // that can handle any children.
                pathname = pathname.substr(0, lastComponent.index);
                route = routes[pathname];
                if (route && !route.recursive) {
                    return null;
                }
            } else {
                return null;
            }
        }

        return route;
    }

    // Makes an action that indicates to the logger that the
    // request has been completed.
    function requestCompleted(id) {
        if (logger) {
            return function (M, conn, success, failure) {
                M.call(logger, {id: id, status: "complete", time_stamp: new Date()}, success, failure);
            };
        } else {
            return WS.drain;
        }
    }

    // Extract some info from the request that we wish to send
    // to the logger. The resultant object is JSON.stringify-able.
    function requestInfo(id, req, route) {
        return {
            time_stamp: new Date(),
            id: id,
            route: {
                path: route.path,
                root_url: route.root_url,
                visited: route.visited,
                time_stamp: route.time_stamp
            },
            method: req.method,
            headers: req.headers,
            trailers: req.trailers,
            url: req.url,
            connection: {
                remoteAddress: req.connection.remoteAddress,
                remotePort: req.connection.remotePort
            }
        };
    }

    var server = createServer(function (request, response) {
        ++requestID;
        request.url = URL.parse(request.url);
        var route = findRoute(request.url.pathname);
        if (route) { 
            route.visited++; 
        }
        if (logger) {
            IO.run(requestInfo(requestID, request, route), logger);           
        }
        if (route) {
            if (route.dynamic) {
                delete routes[route.path];
            }
            request.url.root_url = route.root_url || request.url.pathname;
            var handler = methods[request.method] || methods['default'];
            handler(requestID, request, response, route);
        } else if (WS.four_oh_four) {
            // Route or method not found.
            // Maybe we have a "not found" handler?
            wsrun({id: requestID, route: route, request: request, response: response}, WS.four_oh_four);
        } else {
            response.end("404");
        }
    });

    var knownMimeTypes = [
        {pat: /\.txt$/i, mime: 'text/plain'},
        {pat: /\.html?$/i, mime: 'text/html'},
        {pat: /\.css$/i, mime: 'text/css'},
        {pat: /\.md$/i, mime: 'text/plain'},
        {pat: /\.mdown$/i, mime: 'text/plain'},
        {pat: /\.markdown$/i, mime: 'text/plain'},
        {pat: /\.png$/i, mime: 'image/png'},
        {pat: /\.jpe?g$/i, mime: 'image/jpeg'},
        {pat: /\.tiff?$/i, mime: 'image/tiff'},
        {pat: /\.ico$/i, mime: 'image/x-icon'},
        {pat: /\.js$/i, mime: 'application/javascript'},
        {pat: /\.json$/i, mime: 'application/json'},
        {pat: /\.wav$/i, mime: 'audio/x-wav'},
        {pat: /\.aiff$/i, mime: 'audio/x-aiff'},
        {pat: /\.mp3$/i, mime: 'audio/mpeg'},
        {pat: /\.m4a$/i, mime: 'audio/mp4'},
        {pat: /\.ogg$/i, mime: 'audio/ogg'},
        {pat: /\.mp4$/i, mime: 'video/mp4'},
        {pat: /\.ogv$/i, mime: 'video/ogg'}
        ];

    function guessMimeType(path, mimeType) {
        if (mimeType) { return mimeType; }

        var i, N, m;
        for (i = 0, N = knownMimeTypes.length; i < N; ++i) {
            m = knownMimeTypes[i];
            if (m.pat.test(path)) {
                return m.mime;
            }
        }

        return mimeType;
    }

    function guessEncoding(mime, encoding) {
        return encoding || (/^text\//.test(mime) ? 'utf8' : null);
    }

    // Given kvs as an object whose keys are ids and values are
    // actions that those ids are to be mapped to, returns an
    // isomorphic object whose keys are the same but whose values
    // are urls that will trigger those actions. The given timeout_secs
    // applies to all the generated urls and will default to infinity
    // if omitted.
    function wslinks(kvs, failure) {
        var result = {}, k;
        
        for (var k in kvs) {
            result[k] = wslink.call(this, kvs[k], failure);
        }

        return result;
    }

    // Make a single link that triggers the action.
    function wslink(action, failure) {
        var root = this.input.request.url.root_url, path;
        if (action instanceof Function) {
            path = root + '/' + uniqueID();
            this._dynlinks.push(path);
            routes[path] = mkRoute(bindAction(action, this, failure), path, root);
            return path;
        } else {
            console.assert(typeof(action) === 'string');
            return action;
        }
    }

    // Generates a unique sha1 every time you call it.
    // Useful for unique URLs. Well, we're relying on sha1
    // to turn up collisions only on the extremely rare
    // occasion.
    var uniqueID = (function () {
        var crypto = require('crypto');
        var salt = crypto.randomBytes(256);
        var id = 0;
        return function () {
            var sha1 = crypto.createHash('sha1');
            sha1.update(salt);
            id += 1 + Math.random();
            sha1.update('' + id);
            return sha1.digest('hex');
        };
    }());

    function bindAction(action, W, failure) {
        action = IO.do(action);
        return function (_, input, success, _fail) {
            W.call(action, input, success, failure);
        };
    }

    //////////////////////////////////////////////
    // The core orchestrator overrides.

    var sessionExpiredError = IO.raise("session_expired");

    function wscall(action, input, success, failure) {
        this.input = input;
        Ex.call.call(this, this._expired || action, input, success, failure);
    }

    function wsdrain(M, conn, succ, fail) {
        try {
            conn.response.end();
        } catch (e) {
            // Keep quiet. No need to make a fuss.
        }
    }

    var WSIO = {};

    function prepareWSIO() {
        for (var k in IO) {
            WSIO[k] = IO[k];
        }
        for (var k in WS) {
            WSIO[k] = WS[k];
        }
    }

    // Every service request fired off gets to store some
    // custom state information in the WS object itself.
    // To handle that, we create a new object based on the WS
    // object and make that the orchestrator of the service run.
    function wsrun(conn, action) {
        var wsc = Object.create(Ex);
        wsc.call = wscall;
        wsc.drain = wsdrain;
        wsc.links = wslinks;
        wsc.link = wslink;
        wsc._api = WSIO;
        wsc._dynlinks = [];
        wsc.run(conn, action);
    }

    return WS;
};

module.exports = IO;
