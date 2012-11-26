// Paul Graham's [Arc Challenge] written using IO.WebServer.
// http://paulgraham.com/arcchallenge.html
//
// The challenge: 
//
// Write a program that causes the url said (e.g.  http://localhost:port/said)
// to produce a page with an input field and a submit button. When the submit
// button is pressed, that should produce a second page with a single link
// saying "click here." When that is clicked it should lead to a third page
// that says "you said: ..." where ... is whatever the user typed in the
// original input field. The third page must only show what the user actually
// typed. I.e. the value entered in the input field must not be passed in the
// url, or it would be possible to change the behavior of the final page by
// editing the url.
//
// Notes:
//
// Cookie based solutions are almost always wrong for this challenge (I think).
// This server doesn't suffer from the cookie related problem mentioned in
// http://arclanguage.org/item?id=1263. 
// 
// Run using - node arc.js
// Then visit http://localhost:9000/said in your browser.

var IO = require('../IO.WebServer.js');

var ws = IO.WebServer(9000);

ws.route('/said', 
        wr([
            '<form name="input" action="/click" method="post">',
            '<input type="text" name="blabberings"/>',
            '<input type="submit" value="Submit"/>',
            '</form>'
            ].join('')
          ));

ws.route('/click', 
        IO.do([
            ws.expire(60), // Optional: Expire the session after 1 minute once you come here. 
            wr(function (W, conn) {
                return '<a href="' + W.link(wr('you said: <b>' + conn.data.blabberings + '</b>')) + '">click here</a>';
            })
            ]));

ws.start();

function wr(x) { 
    return ws.page(ws.write(x)); 
}
