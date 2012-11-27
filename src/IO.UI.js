
(function (config) {
    var IO = config.IO;

    //////////////////////////////////////
    // Binding UI elements to IO actions.

    // 'on' associates an action with an event generated
    // by a GUI element. Use the IO.off action within
    // the action sequence to dissociate the action from 
    // the GUI element.
    //
    // Ex:
    //      IO.on('sendButton', 'click', IO.log('button clicked'));
    //
    //      // One-time action
    //      IO.on('sendButton', 'click', IO.do([
    //          IO.log('Rocket launched .. won't happen again!'),
    //          IO.off
    //          ]));
    //
    //      // html
    //      <button id="sendButton">Send</button>
    IO.on = function (element, eventName, action) {
        if (typeof element === 'string') {
            // Use getElementById to resolve. Works only in a browser.
            element = document.getElementById(element);

            // Try selector if the specified string is not an id.
            if (!element) {
                element = document.querySelector(element);
            }
        }

        // It is a programming error to bind an action to a non-existent element.
        console.assert(element);

        // Support both DOM-style UI elements as well as 
        // Backbone.js-style event emitters.
        var off;
        if (element.removeEventListener) {
            off = function () {
                element.removeEventListener(eventName, listener);
            };
        } else if (element.off) {
            off = function () {
                element.off(eventName, listener);
            };
        }
        console.assert(off);


        function listener(event) {
            var Ex = Object.create(IO.Ex);
            Ex.off = off;
            Ex.run(event, action);
        }

        if (element.addEventListener) {            
            element.addEventListener(eventName, listener);
        } else if (element.on) {
            element.on(eventName, listener);
        } else {
            console.assert(false);
        }
    };

    // When run within an action sequence bound to a UI element,
    // this will dissociate the action from it.
    IO.off = function (Ex, input, success, failure) {
        console.assert(Ex.off);
        Ex.off();
        Ex.call(success, input, Ex.drain, failure);
    };

    // Sets the UI element's 'value' to the received input.
    // Passes the input through.
    //
    // @param element HTMLElement instance.
    // @param setter Must be either a string naming one of the builtin setters
    //   or a function of the form function (element, input) { ... }
    //   Default is 'value'.
    // @param formatter 
    //
    // Available built-in setters are 'value', 'innerText', 'innerHTML' and 'children'.
    // If you want the input to be appended, you can suffix the names with
    // a '+', so 'innerText+' will result in the input being appended as text
    // to the contents of the element. Prefixing with '+' will result in the
    // input being prepended to the contents. Note that in the case of 'value',
    // '+' may be interpreted as numeric addition or string concatenation depending
    // on the element type.
    //
    // Ex:
    //      IO.run('start', IO.do([
    //          IO.clock(1000),
    //          IO.show('counter', 'innerText')
    //      ]));
    //
    //      <span id='counter'></span>
    //
    IO.show = function (element, setter, formatter) {
        if (typeof element === 'string') {
            // Use getElementById to resolve. Works only in a browser.
            element = document.getElementById(element);
        }

        console.assert(element);

        formatter = formatter || function (input) { return input; };

        if (setter === null || setter === undefined) {
            setter = commonElementSetters.value;
        } else {
            if (typeof setter === 'string') {
                setter = commonElementSetters[setter];
                console.assert(setter);
            } else {
                console.assert(typeof setter === 'function');
            }
        }

        return function show_(M, input, success, failure) {
            setter(element, formatter(input));

            // We continue, so that multiple shows can be setup
            // for the same input.
            M.call(success, input, M.drain, failure);
        };
    };

    var commonElementSetters = {
        'value': function (element, input) {
            element.value = input;
        },
        'value+': function (element, input) {
            element.value += input;
        },
        '+value': function (element, input) {
            element.value = input + element.value;
        },
        'innerText': function (element, input) {
            element.innerText = input;
        },
        '+innerText': function (element, input) {
            element.innerText = input + element.innerText;
        },
        'innerText+': function (element, input) {
            element.innerText += input;
        },
        'innerHTML': function (element, input) {
            element.innerHTML = input;
        },
        '+innerHTML': function (element, input) {
            element.innerHTML = input + element.innerHTML;
        },
        'innerHTML+': function (element, input) {
            element.innerHTML += input;
        },
        'children': function (element, input) {
            console.assert(input instanceof HTMLElement);
            while (element.childElementCount > 0) {
                element.removeChild(element.lastElementChild);
            }
            element.insertAdjacentElement('beforeend', input);
        },
        'children+': function (element, input) {
            console.assert(input instanceof HTMLElement);
            element.insertAdjacentElement('beforeend', input);
        },
        '+children': function (element, input) {
            console.assert(input instanceof HTMLElement);
            element.insertAdjacentElement('afterbegin', input);
        }
    };

    config.export(IO);
}((function () {
    if (typeof window !== 'undefined' && typeof document !== 'undefined' && this === window) {
        // In browser.
        console.assert(window.IO); // Must've loaded the IO.js script already.
        return {IO: window.IO, export: function (IO) { window.IO = IO; }};
    }

    if (typeof module !== 'undefined') {
        // In Node.js
        return {IO: require('./IO.js'), export: function (IO) { module.exports = IO; }};
    }

    console.assert(false); // Unknown environment.
}())));
