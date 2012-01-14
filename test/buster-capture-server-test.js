var buster = require("buster");
var assert = buster.assert;
var refute = buster.refute;
var busterServer = require("./../lib/buster-capture-server");
var bResources = require("buster-resources");
var bCapServSlave = require("./../lib/slave");
var bCapServSession = require("./../lib/session");
var faye = require("faye");
var http = require("http");
var h = require("./test-helper");

function createServer(done) {
    var httpServer = http.createServer(function (req, res) {
        res.writeHead(h.NO_RESPONSE_STATUS_CODE);
        res.end();
    });

    httpServer.listen(h.SERVER_PORT, done);
    return httpServer;
}

buster.assertions.add("inArray", {
    assert: function (array, actual) { return array.indexOf(actual) >= 0; },
    assertMessage: "Expected xxx",
    refuteMessage: "Expected yyy"
});

buster.testCase("Buster Capture Server", {
    "attached to server": {
        setUp: function (done) {
            this.httpServer = createServer(done);
            this.server = busterServer.create();
            this.server.attach(this.httpServer);

            this.validSessionPayload = {
                resourceSet: {
                    load: ["/foo.js"],
                    resources: {
                        "/foo.js": {
                            content: "var a = 5 + 5;"
                        }
                    }
                }
            };
        },

        tearDown: function (done) {
            this.httpServer.on("close", done);
            this.httpServer.close();
        },

        "test unknown URL": function (done) {
            h.request({path: "/doesnotexist", method: "GET"}, function (res, body) {
                assert.equals(h.NO_RESPONSE_STATUS_CODE, res.statusCode);
                done();
            }).end();
        },

        "should list known resources for GET /resources": function (done) {
            this.server.createSession({
                resourceSet: {
                    resources: {
                        "/foo.js": {
                            content: "cake",
                            etag: "123abc"
                        }
                    }
                }
            });

            h.request({path: "/resources"}, function (res, body) {
                assert.equals(res.statusCode, 200);
                var actual = JSON.parse(body);
                assert.equals(actual, {"/foo.js": ["123abc"]});
                done();
            }).end();
        },

        "should gc for DELETE /resources": function (done) {
            var stub = this.stub(bResources, "gc");
            h.request({path: "/resources", method: "DELETE"}, function (res, body) {
                assert.equals(res.statusCode, 200);
                assert(stub.calledOnce);
                done();
            }).end();
        },

        "captures slave": function (done) {
            var self = this;
            this.server.oncapture = function (req, res, slave) {
                assert.equals(self.server.slaves.length, 1);
                assert.same(self.server.slaves[0], slave);

                res.writeHead(666, {"X-Foo": "bar"});
                res.end();
            };

            h.request({path: this.server.capturePath, method: "GET"}, function (res, body) {
                assert.equals(res.statusCode, 666);
                assert.equals(res.headers["x-foo"], "bar");
                done();
            }).end();
        },

        "errors when capturing slave with no oncapture handler": function (done) {
            h.request({path: this.server.capturePath, method: "GET"}, function (res, body) {
                assert.equals(res.statusCode, 400);
                assert.match(body, "no 'oncapture' handler");
                done();
            }).end();
        },

        "with basic oncapture handler": {
            setUp: function () {
                this.oncaptureSlaves = [];
                this.server.oncapture = function (req, res, slave) {
                    this.oncaptureSlaves.push(slave);
                    res.writeHead(200);
                    res.end();
                }.bind(this);
            },

            "captures with custom capture URL": function (done) {
                this.server.oncapture = function (req, res, slave) {
                    res.end();
                    done();
                };

                this.server.capturePath = "/foo";
                h.request({ path: "/foo", method: "GET" }, function () {}).end();
                assert(true);
            },

            "captures slave with joinable session in progress": function (done) {
                this.server.createSession({});
                var self = this;

                h.request({path: this.server.capturePath, method: "GET"}, function () {
                    assert(self.oncaptureSlaves[0].sessionInProgress);
                    done();
                }).end();
            },

            "captures slave with none-joinable session in progress": function (done) {
                var self = this;

                h.request({path: this.server.capturePath, method: "GET"}, function () {
                    self.server.createSession({joinable: false});
                    var stub = self.stub(self.server.slaves[0], "startSession");
                    h.request({path: self.server.capturePath, method: "GET"}, function () {
                        refute(stub.called);
                        done();
                    }).end();
                }).end();
            },

            "having a slave": {
                setUp: function (done) {
                    var self = this;
                    h.request({path: this.server.capturePath, method: "GET"}, function (res, body) {
                        self.slave = self.oncaptureSlaves[0];
                        done();
                    }).end();
                },
            },

            "having multiple slaves created": {
                setUp: function (done) {
                    var self = this;
                    h.request({path: this.server.capturePath, method: "GET"}, function (res, body) {
                        h.request({path: self.server.capturePath, method: "GET"}, function (res, body) {
                            h.request({path: self.server.capturePath, method: "GET"}, function (res, body) {
                                done();
                            }).end();
                        }).end();
                    }).end();
                },

                "stores slaves": function () {
                    assert.equals(this.server.slaves.length, 3);
                },

                "unloads slaves that end": function (done) {
                    var self = this;
                    var slaveToEnd = self.oncaptureSlaves[1];

                    slaveToEnd.on("end", function () {
                        assert.equals(self.server.slaves.length, 2);
                        assert.inArray(self.server.slaves, self.oncaptureSlaves[0]);
                        refute.inArray(self.server.slaves, self.oncaptureSlaves[1]);
                        assert.inArray(self.server.slaves, self.oncaptureSlaves[2]);
                        done();
                    });

                    h.emulateCloseBrowser(slaveToEnd);
                },

                "lists slaves when creating session": function (done) {
                    var self = this;
                    h.request({path: "/sessions", method: "POST"}, function (res, body) {
                        var response = JSON.parse(body);

                        assert.match(response.slaves, [
                            {id: self.oncaptureSlaves[0].id},
                            {id: self.oncaptureSlaves[1].id},
                            {id: self.oncaptureSlaves[2].id}
                        ]);
                        
                        done();
                    }).end(new Buffer(JSON.stringify({
                        resourceSet: {load: [],resources: {}}
                    }), "utf8"));
                },

                "starts session immediately in slave when no other sessions are present": function (done) {
                    var self = this;
                    h.request({path: "/sessions", method: "POST"}, function (res, body) {
                        assert.equals(res.statusCode, 201);
                        assert(self.oncaptureSlaves.every(function (s) { return s.sessionInProgress; }));
                        done();
                    }).end(JSON.stringify(this.validSessionPayload));
                },

                "ignores malformed JSON when creating session with HTTP": function (done) {
                    var self = this;
                    h.request({path: "/sessions", method: "POST"}, function (res, body) {
                        assert.equals(400, res.statusCode);
                        assert.match(body, /invalid JSON/i);
                        assert.equals(0, self.server.sessions.length);
                        done();
                    }).end("{not json}!");
                },

                "handles validation when creating session with HTTP": function (done) {
                    var self = this;
                    this.stub(bCapServSession, "validate");
                    bCapServSession.validate.returns("An error.");

                    h.request({path: "/sessions", method: "POST"}, function (res, body) {
                        assert.equals(400, res.statusCode);
                        assert.match(body, "An error.");
                        assert.equals(0, self.server.sessions.length);
                        done();
                    }).end("{}");
                }
            }
        },

        "has default logger": function () {
            assert.equals(typeof this.server.logger.error, "function");
            assert.equals(typeof this.server.logger.warn, "function");
            assert.equals(typeof this.server.logger.log, "function");
            assert.equals(typeof this.server.logger.info, "function");
            assert.equals(typeof this.server.logger.debug, "function");
        },

        "setting logger after the fact affects bayeux logging": function (done) {
            var newLogger = h.mockLogger(this);
            this.server.logger = newLogger;

            var publication = this.server.bayeux.publish("/foo", {});
            publication.callback(function () {
                assert(newLogger.debug.called);
                done();
            });
        }
    },

    "without an http server": {
        setUp: function (done) {
            this.httpServer = createServer(done);
            this.middleware = busterServer.create();
        },

        tearDown: function (done) {
            this.httpServer.on("close", done);
            this.httpServer.close();
        },

        "should manually attach": function (done) {
            this.middleware.attach(this.httpServer);

            h.request({ path: "/resources", method: "GET" }, function (res, body) {
                assert.equals(200, res.statusCode);
                done();
            }).end();
        },

        "should manually attach messaging client": function (done) {
            this.middleware.attach(this.httpServer);
            var url = "http://localhost:" + h.SERVER_PORT + "/sessions/messaging";
            var client = new faye.Client(url);

            var subscription = client.subscribe("/ping", function (message) {
                assert.equals(message, "Hello world");

                // Meh...
                subscription.cancel();
                client.disconnect();
                setTimeout(done, 5);
            });

            subscription.callback(function () {
                client.publish("/ping", "Hello world");
            });
        }
    }
});