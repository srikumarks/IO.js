// A simple web server that serves files off the
// current directory.
//
// Run as -
//  node ws.js
//
// and visit http://localhost:9000/ws.js in your browser.
//
// Notes: 
//  Doesn't do directory listings. You need to know your file name.

var IO = require('../src/IO.WebServer.js');
var ws = IO.WebServer(9000);

var reportInvalidURL = IO.cond([
        [{error: 'path not found'}, error('Invalid URL')],
        [IO.cond.true, error('Cannot list directories.')]
        ]);

ws.route('/', 
        IO.do([
            IO.catch(reportInvalidURL),
            ws.serveDir('./')
            ]), 
        true);

ws.start();

function error(text) {
    return IO.do([
            function (err) { return err.input; },
            ws.page(ws.write(text))
            ]);
}
