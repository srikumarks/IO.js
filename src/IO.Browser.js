
console.assert(IO);

(function (Browser) {

    //////////////////////////////////////
    // Binding UI elements to IO actions.

    // 'on' associates an action with an event generated
    // by a GUI element. Use the IO.Browser.off action within
    // the triggered action sequence to dissociate the action from 
    // the GUI element.
    //
    // Ex:
    //      IO.Browser.on('sendButton', 'click', IO.log('button clicked'));
    //
    //      // One-time action
    //      IO.Browser.on('sendButton', 'click', IO.do([
    //          IO.log('Rocket launched .. won't happen again!'),
    //          IO.Browser.off
    //          ]));
    //
    //      // html
    //      <button id="sendButton">Send</button>
    Browser.on = function (element, eventName, action) {
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
    Browser.off = function (Ex, input, success, failure) {
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
    //          IO.Browser.show('counter', 'innerText')
    //      ]));
    //
    //      <span id='counter'></span>
    //
    Browser.show = function (element, setter, formatter) {
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

    // IO.Browser.get('url://somewhere/something', undefined, 'responseText')
    //
    // Will fetch the URL and pass the contents to the next stage.
    // Simple wrapper fro XMLHttpRequest.
    //
    // The returned action has a property named 'interrupt'. This is an
    // action which when run will cause the sequence (and the orchestrator
    // that's running it) executing the get action to abort with the 
    // 'interrupted' condition. This uses IO.interruptible. Note that
    // the interrupt action can be run within any orchestrator.
    Browser.get = function (url, responseType, responseKey) {
        return IO.interruptible(function (oninterrupt) {
            return function xmlhttprequest_(M, input, success, failure) {
                var request = new XMLHttpRequest();
                var thisResponseKey = responseKey;
                var done = false;
                request.open('GET', url, true);
                if (responseType) {
                    request.responseType = responseType;
                    thisResponseKey = thisResponseKey || 'response';
                }
                thisResponseKey = thisResponseKey || 'responseText';
                request.onload = function () {
                    var response = request[thisResponseKey];
                    done = true;
                    if (response) {
                        M.call(success, response, M.drain, failure);
                    } else {
                        request.onerror();
                    }
                };
                request.onerror = function () {
                    done = true;
                    M.call(IO.raise('XMLHttpRequestFailed', url, responseType, thisResponseKey), input, success, failure);
                };
                oninterrupt(function () {
                    if (!done) {
                        request.abort();
                        M.delay(0, IO.raise('interrupted'), {reason: 'XMLHttpRequestInterrupted', input: input}, success, failure);
                    }
                });
                request.send();
            };
        });
    };
}(IO.Browser = {}));

