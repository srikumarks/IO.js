// Copyright © 2012 Srikumar K. S.
// http://github.com/srikumarks/IO.js
//
// MIT License:
// 
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
// 
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
// 
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

//////////////////////////////////////////////////////////////////////////
// IO is a library to help tame asynchronous code in Javascript.
// The focus of IO is a) flexible error management, b) support for data
// flow and c) customizability of the sequencing logic.
//
// Why is this called IO? ... because if you only have pure computations
// to do, then you shouldn't be using this library.
//
// Two orchestrators are provided - IO.Ex is the normal one
// and IO.Tracer is the tracing executor that dumps info to the
// console as the steps in an action execute.
//
// See README.mdown for documentation and IO.tests.js for tests and examples.

(function (IO) {

IO.do = chain;
IO.pass = pass;
IO.fail = fail;

IO.branch = function (action, success, failure) {
    return branch(autowrap(action), autowrap(success), autowrap(failure));
};

// nextTick function largely taken from Q.js by kriskowal.
//  repo: https://github.com/kriskowal/q
//  file: q.js
//
// The "new Image()" hack is from - http://www.nonblocking.io/2011/06/windownexttick.html
// Whoa! The original source of that hack is JSDeferred - https://github.com/cho45/jsdeferred
//
// Use the fastest possible means to execute a task in a future turn
// of the event loop.
var nextTick = (function () {
    if (typeof process !== "undefined" && typeof process.nextTick === 'function') {
        // node
        return process.nextTick;
    } else if (typeof setImmediate === "function") {
        // In IE10, or use https://github.com/NobleJS/setImmediate
        return setImmediate;
    } else if (typeof MessageChannel !== "undefined") {
        // modern browsers
        // http://www.nonblocking.io/2011/06/windownexttick.html
        var channel = new MessageChannel();
        // linked list of tasks (single, with head node)
        var head = {}, tail = head;
        channel.port1.onmessage = function () {
            head = head.next;
            var task = head.task;
            delete head.task;
            task();
        };
        return function (task) {
            tail = tail.next = {task: task};
            channel.port2.postMessage(0);
        };
    } else if (typeof Image !== 'undefined') {
        // Fast hack for not so modern browsers.
        return function (task) {
            var img = new Image();
            img.onerror = task;
            img.src = 'data:image/png,' + Math.random();
        };
    } else {
        // Worst case.
        return function (task) {
            return setTimeout(task, 0);
        };
    }
}());


function actionArray(actions, ix) {
    ix = ix || 0;
    var action = actions[ix];
    if (action instanceof Array) {
        return action;
    } else {
        return Array.prototype.slice.call(actions, ix);
    }
}

//  A simple error wrapper class. This is the object
//  received as a "value" in catch blocks.
function IOError(M, error, input, success, failure) {
    this.M = M;
    this.error = error;
    this.input = input;

    // Provides a error.resume(value). When invoked,
    // this will cause the process to resume from the
    // point the error occurred, as though the point
    // at which the error was raised had succeeded.
    this.resume = autobranch(M, success, M.drain, failure);

    // Provides a error.rollback(value). This is an
    // I "giveup" function which when invoked in a catch
    // block propagates the error handling responsibility
    // to the outer catch block.
    this.rollback = autodrain(M, failure);

    // The raw continuations are also passed along in case
    // the handler wishes to connect them to other action
    // sequences.
    this.success = success;
    this.failure = failure;
}

// An error value indicating to generators to pause generation
// They call onresume with a callback function to be notified
// of the stream resuming operations.
function IOPauseCondition() {
    this._resume_callbacks = [];
}

IOPauseCondition.prototype.onresume = function (callback) {
    this._resume_callbacks.push(callback);
};

IOPauseCondition.prototype.resume = function () {
    while (this._resume_callbacks.length > 0) {
        this._resume_callbacks.pop()();
    }
};

// A basic orchestrator.
var ExM = {
    _api: IO,
    maxdepth: 50,
    depth: 0,
    kBufferCapacity: 8,

    // This is the core function where all the action happens.
    // `action` is an action function and if it throws an exception, 
    // that is caught and propagated as a normal asynchonous error.
    // In order to not blow the stack, call occasionally makes
    // itself asynchronous.
    call: function (action, input, success, failure) {
        var M = this;
        if (M.depth++ < M.maxdepth) {
            try {
                action(M, input, success || M.drain, failure || M.drain);
            } catch (e) {
                console.error(e.stack);
                if (failure) {
                    try {
                        failure(M, new IOError(M, e, input, success, failure), M.drain, M.drain);
                    } catch (e2) {
                        console.error("failure handler failed with " + e2);
                    }
                }
            }
        } else {
            nextTick(function () {
                M.depth = Math.min(0, M.maxdepth - 1);
                M.call(action, input, success, failure);
            });
        }
    },

    // A no-op.
    drain: function (M, input, success, failure) {},

    // A simple wrapper to call, intended for users of the IO module.
    // They shouldn't be using any other function to run an action.
    run: function (input, action) {
        this.call(autowrap(action), input, this.drain, this.drain);
    },

    delay: function (ms, action, input, success, failure) {
        var M = this;
        (ms > 0 ? setTimeout : nextTick)(function () {
            M.call(action, input, success, failure);
        }, ms);
    }
};

// Starts the "success" continuation.
function pass(M, input, success, failure) {
    if (success) {
        M.call(success, input, M.drain, failure);
    } 
}

// Turns the action function into something that can be
// used as a callback to other API code. Once this
// action terminates (either by succeeding or failing),
// it stops.
function autodrain(M, action) {
    return autobranch(M, action, M.drain, M.drain);
}

// Similar to autodrain, but branches to success once the
// action succeeds and to failure if it fails.
function autobranch(M, action, success, failure) {
    return function (input) {
        M.call(action, input, success, failure);
    };
}


// Starts the failure continuation.
function fail(M, input, success, failure) {
    if (failure) {
        M.call(failure, input, M.drain, M.drain);
    }
}

// Makes an action that always executes in the given orchestrator.
function bind(M, action) {
    return function (_, input, success, failure) {
        M.call(action, input, success, failure);
    };
}

// Makes an action that ignores its input and uses
// the given object instead.
function send(input, action) {
    return function (M, _, success, failure) {
        M.call(action, input, success, failure);
    };
}

// Sequences two actions.
function seq(a, b) {
    return function (M, input, success, failure) {
        M.call(a, input, seq(b, success), failure);
    };
}

// If a succeeds, the "success" continuation is started and
// if it fails, "failure" is started.
function branch(a, success, failure) {
    return function (M, input, succ2, fail2) {
        M.call(a, input, success, failure);
    };
}

// Always branches to failure
function failseq(action, failure) {
    return branch(action, failure, failure);
}

// There are 4 types of action functions at the user level.
// autowrap(fn) takes a function of any one of these kinds
// and returns the only action form supported inside this module.
//
// While internally actions always have the signature -
//  function (M, input, success, failure) ...
// where success and failure are also actions, the IO module
// user can provide action functions in one of 4 forms,
// identified using the number of declared arguments.
//
// function (input) { .. return something; }
// A normal one-input function which is taken to succeed if it
// returns a value and to fail if it throws an exception.
// If the function wants to stop execution, it can return
// undefined.
//
// function (callback, errback) { .. }
// A common pattern seen, where callback and errback are both one
// argument functions. The input flowing through the sequence
// is ignored.
//
// function (input, callback, errback) { .. }
// Similar to the two argument form, but the data flowing in 
// the sequence at the point this action executes is available 
// as "input".
//
// function (M, input, callback, errback) {...}
// This is the fully customizeable form, where M is an orchestrator
// and callback and errback are normal actions.
//
function autowrap(action) {
    if (action instanceof Function) {
        switch (action.length) {
            case 4: return action;
            case 1: return wrapFn(action);
            case 3: return wrapAsync3(action);
            case 2: return wrapAsync2(action);
            default: 
                    throw "Unsupported action type";
        }
    } else if (action instanceof Object) {
        return wrapObj(action);
    } else {
        throw "BAD action type!";
    }
}

// Wrap a simple function.
function wrapFn(fn) {
    return function dynamic_(M, input, success, failure) {
        try {
            var result = fn(input);
            if (result === undefined) {
                // Stop the execution sequence.
            } else if (result instanceof Function) {
                // When the function returns an action, splice
                // it into the current action sequence. This
                // serves as a "dynamic" action determined at the
                // time the input is available.
                M.call(autowrap(result), input, success, failure);
            } else {
                // Ordinary value. Treat it as the output of the
                // action that has to be passed on to the rest of
                // the sequence.
                M.call(success, result, M.drain, failure);
            }
        } catch (e) {
            M.call(failure, e, M.drain, M.drain);
        }
    };
}

// Three-argument form.
function wrapAsync3(action) {
    return function (M, input, success, failure) {
        M.call(function (M, input, success, failure) {
            action(input, function (input) {
                M.call(success, input, M.drain, failure);
            }, function (err) {
                M.call(failure, err, M.drain, M.drain);
            });
        }, input, success, failure);
    };
}

// Two argument form.
function wrapAsync2(action) {
    return function (M, input, success, failure) {
        M.call(function (M, input, success, failure) {
            action(function (input) {
                M.call(success, input, M.drain, failure);
            }, function (err) {
                M.call(failure, err, M.drain, M.drain);
            });
        }, input, success, failure);
    };
}

// Object with one key describing the method and the value being an array.
function wrapObj(obj) {
    return function (M, input, success, failure) {
        M.call(autowrap(expandObj(M, obj)), input, success, failure);
    };
}

function expandObj(M, obj) {
    var k, v, a;
    if (obj instanceof Object) {
        for (k in obj) {
            a = M._api[k];
            v = obj[k];
            return (v instanceof Array) ? a.apply(M._api, v) : a.call(M._api, v);
        }
    } else {
        return obj;
    }
}

// Some functions support providing a sequence of actions
// as an array or a single action. autoseq normalizes 
// both cases into a single action.
function autoseq(action) {
    return (action instanceof Array) ? chain(action) : autowrap(action);
}

// Turns an array of actions,  or actions given as arguments,
// into a single action that runs each in sequence, piping the
// output of each to the next.
function chain(_actions) {
    // The simplest implementation is just this -
    //   actions.reduce(seq, pass)
    // but doing that can end up deeply nesting function
    // calls for long sequences, besides, it is not necessary
    // to eagerly compute all the continuations involved in
    // a sequence before the sequence gets to run. It is
    // enough if we compute the continuations on the fly
    // as the sequence executes. That incurs a bit of closure
    // creation memory overhead, but that is needed for
    // correctness of the generated continuations.
    var actions = actionArray(arguments).map(autowrap);
    switch (actions.length) {
        case 0: return pass;
        case 1: return actions[0];
        default: return function (M, input, success, failure) {
            M.call(chain_iter(actions, 0, success), input, M.drain, failure);
        }
    }
}

// Private function for iterating through a sequence of actions.
function chain_iter(actions, i, success) {
    if (i >= actions.length) {
        return success;
    } else {
        return function (M, input, _success, failure) {
            M.call(actions[i], input, chain_iter(actions, i + 1, success), failure);
        };
    }
}

// Raises an error, which gets passed first to the immediately
// preceding catch point.
IO.raise = function (err) {
    return function raise_(M, input, success, failure) {
        M.call(failure, new IOError(M, err, input, success, failure), M.drain, M.drain);
    };
};

// The argument 'interruptible' is a function (oninterrupt) that is expected to
// return an action that needs to be made interruptible.  'oninterrupt' is a
// function (handler) that installs the given zero-argument handler to be
// called upon interruption. The resultant action is given an addition property
// named 'interrupt' which is an action to be used to interrupt the original
// action irrespective of which orchestrator is running it.
//
// This is intended for use by low level constructs that may have different
// mechanisms for interruption. Whenever IO.raise can be used, IO.finally is
// likely to be adequate as a mechanism for installing cleanup actions.
IO.interruptible = function (interruptible) {
    var interrupt = cont;

    function oninterrupt(handler) {
        // Install the interrupt handler. This is basically
        // some zero-argument procedure to run when an interruption 
        // occurs.
        interrupt = (function (oldInterrupt) {
            return function (M, input, success, failure) {
                handler();
                M.call(oldInterrupt, input, success, failure);
            };
        }(interrupt));
    }

    var action = interruptible(oninterrupt);

    // This wrapper basically delays looking up the 'interrupt'
    // variable until the time it is required.
    action.interrupt = function interrupt_(M, input, success, failure) {
        M.call(interrupt, input, success, failure);
    };

    return action;
};

// A general mechanism for interrupting an arbitrary sequence.  You first call
// IO.interruption(reason) to make two actions - 'mark' and 'interrupt'. 
//
// The 'mark' action can be used in any sequence to mark the fact that an
// interruption can be raised in that sequence even when it is suspended on
// some other action.  In such cases, IO.finally or IO.catch can be used to
// trap the generated 'interrupted' condition and take appropriate action.
//
// The 'interrupt' action can be used in any sequence to interrupt all of the
// other sequences that have been 'mark'ed.
//
// Note that the 'interrupt' and 'mark' actions can be part of different
// sequences that are running in different orchestrators. In fact, this is
// pretty much the point of this. However, they both can also be part of the
// same sequence as well.
IO.interruption = function (reason) {
    var handlers = {};
    var newid = 0;

    return {
        mark: function (M, input, success, failure) {
            var id = ++newid;
            handlers[id] = function () {
                delete handlers[id];
                M.delay(0, IO.raise('interrupted'), {reason: reason, input: input}, success, failure);
            };
            M.call(success, input, M.drain, failure);
        },
        interrupt: function (M, input, success, failure) {
            var keys = Object.keys(handlers);
            for (var i = 0; i < keys.length; ++i) {
                handlers[keys[i]]();
            }
            M.call(success, input, M.drain, failure);
        }
    };
};

// Discards the error and proceeds with the input provided
// as though the error didn't occur.
IO.forgive = function (M, err, success, failure) {
    M.call(success, err.input, M.drain, failure);
};

// Tries the action first, and if it fails, passes
// on the error it generated to the onfail action.
// If onfail succeeds, the try is considered to have
// succeeded and executing will continue after the
// try.
IO.try = function (action, onfail) {
    // Support array of actions as well.
    action = autoseq(action);
    onfail = autowrap(onfail);

    return function try_(M, input, success, failure) {
        M.call(action, input, success, branch(onfail, success, failure));
    };
};

// Tries a series of actions one by one until it comes
// to the first one that succeeds. The whole alt action
// is semantically the same as as that succeeding action.
IO.alt = function (actions) {
    return alt_impl(actionArray(arguments).map(autowrap));
};

function alt_impl(actions) {
    if (actions.length === 0) {
        return IO.raise("alt");
    } else {
        return function (M, input, success, failure) {
            M.call(actions[0]
                    , input
                    , success
                    , branch(send(input, alt_impl(actions.slice(1))), success, failure));
        }
    };
};

// Starts all actions simultaneously like IO.fork. The first action
// that completes is the "winning" action that passes its result to
// the output and cancels the other actions.
IO.any = function (actions) {
    return any_impl(actionArray(arguments).map(autowrap));
};

function any_impl(actions) {
    if (actions.length === 0) {
        return IO.raise("IO.any has no actions to run");
    } else {
        return function any_(M, input, success, failure) {
            var done = false;
            var errCount =  0;

            var join = function (M, output, succ_, fail_) {
                if (done) {
                    M.call(fail_, "any", M.drain, M.drain);
                } else {
                    done = true;
                    M.call(success, output, M.drain, failure);
                }
            };

            var joinerr = function (M, err, succ_, fail_) {
                ++errCount;
                M.call(fail_, err, M.drain, M.drain);
                if (errCount === actions.length) {
                    M.call(failure, "any", M.drain, M.drain);
                }
            };

            actions.forEach(function (a) {
                M.delay(0, a, input, join, joinerr);
            });
        };
    }
}

// To use this action maker, the data flowing at this point
// must be an object to which the given kvpairs (also
// expressed as an object) are added before passing 
// control to action.
function sendKV(kvpairs, action) {
    return function (M, input, success, failure) {
        for (var key in kvpairs) {
            input[key] = kvpairs[key];
        }
        M.call(action, input, success, failure);
    };
}

// The core error management function. Catches IO.raise() conditions
// and decides what to do. The given onfail action will execute with
// the error object as its input. The fail handler can either resume
// after the error point, restart the sequence of actions after this
// catch or propagate to the catch handler installed before this one.
IO.catch = function (onfail) {
    onfail = autowrap(onfail);
    return function catch_(M, input, start, traceback) {
        var restartCB = autobranch(M, catch_, start, traceback);
        var restartAct = branch(catch_, start, traceback);
        var withRestart = sendKV({restart: restartCB}, onfail);
        M.call(start, input, M.drain, branch(withRestart, restartAct, traceback));
    };
};

// Routes the given input through the given action and
// routes whatever input arrives from the enclosing sequence
// around the action.
function bindInput(input, action) {
    return function (M, newInput, success, failure) {
        M.call(action
                , input
                , function (M, _, succ_, fail_) {
                    M.call(success, newInput, succ_, fail_);
                  }
                , failure);
    };
}

// Runs action and before exiting action either successfully
// or through a failure, runs the cleanup action before proceeding.
// The cleanup action as well as action both receive the same input
// but the cleanup action's output is drained.
//
// The cleanup action sequence is not expected to launch failure
// sequences of its own. If you wish the cleanup action to happen
// in parallel with the rest of the code, just wrap it in an IO.tee().
IO.finally = function (cleanup, action) {
    cleanup = autowrap(cleanup);
    action = autoseq(action);

    return function finally_(M, input, success, failure) {
        var cleanupB = bindInput(input, cleanup);

        // We need to cleanup before passing on to failure handlers above,
        // but if we do that, we cannot resume from the error point,
        // but we ought to be able to resume from this finally clause,
        // so change the resume point to this finally clause after running
        // the cleanup action and then pass control to failure handlers
        // above.
        var exceptional = seq(IO.add({resume: autobranch(M, finally_, success, failure)}), failure);

        M.call(action, input, seq(cleanupB, success), seq(cleanupB, exceptional));
    };
};

// Takes a list of actions (either as arguments or as an array) and
// runs them all "in parallel", waits for all of them to either complete
// or fail, collects all the results in an array and passes it on to
// the actions after the fork. Both errors as well as success values
// are passed. The actions further down can detect error values using
//      input instanceof IO.Error
IO.fork = function () {
    var actions = actionArray(arguments).map(autowrap);

    return function fork_(M, input, success, failure) {
        var countUp = 0;
        var errUp = 0;
        var results = [];

        var join = function (_, output, succ_, fail_) {
            ++countUp;
            results[output.index] = output.value;
            if (errUp + countUp === actions.length) {
                M.call(success, results, M.drain, failure);
            }
        };

        var errjoin = function (_, err, succ_, fail_) {
            ++errUp;
            results[err.index] = err;
            delete err.index;
            if (errUp + countUp === actions.length) {
                if (countUp === 0) {
                    M.call(failure, err, M.drain, M.drain);
                } else {
                    M.call(success, results, M.drain, failure);
                }
            }
        };

        actions.forEach(function (a, i) {
            var Mi = Object.create(M);
            a = IO.do([a, IO.map(function (output) { return {index: i, value: output}; })]);
            Mi.delay(0, a, input, join, sendKV({index: i}, errjoin));
        });
    };
};

// Spawns off the action without joining it with the
// following steps. This is like a "T" junction and hence
// the name.
IO.tee = function (action) {
    action = autowrap(action);

    return function tee_(M, input, success, failure) {
        nextTick(function () {
            M.call(action, input, M.drain, M.drain);
        });
        M.call(success, input, M.drain, failure);
    };
};

// Starts action and starts a watchdog timer. If the timer
// fires before the action completes, the ontimeout action
// is run before proceeding to fail. The action is not
// expected to fail, but if you want to allow it fail,
// put a catch above it that does nothing. The timeout
// action receives the original whole timeout operation
// as an input argument that can be called (with no arguments)
// to do the thing again.
IO.timeout = function (ms, action, ontimeout) {
    action = autoseq(action);

    return function timeout_(M, input, success, failure) {
        var timedout = false;
        var completed = false;
        setTimeout(function watchdog() {
            timedout = true;
            if (!completed) {
                M.call(ontimeout
                    , function () { M.call(timeout_, input, success, failure); }
                    , failure
                    , failure);
            } 
        }, ms);

        M.call(action, input, function (_, output, succ_, fail_) {
            completed = true;
            if (!timedout) {
                M.call(success, output, M.drain, failure);
            }
        }, failure);
    };
};

// Returns an action that can be used in two places to sync up
// their continuations. The "now" action will complete and continue
// when at least N of "later" actions have been run, with N defaulting
// to 1 when unspecified.
IO.sync = function (N) {
    var countDown = N || 1;
    var followon;

    return {
        now: function sync_now_(M, input, success, failure) {
            followon = function () { 
                // One shot call.
                if (--countDown <= 0) {
                    followon = undefined;
                    M.call(success, input, M.drain, failure); 
                }
            };
        },

        later: function sync_later_(M, input, success, failure) {
            if (followon) {
                followon();
            }
            M.call(success, input, M.drain, failure);
        }
    };
};

// Calls fn passing it the input flowing in sequence at that
// point, discards its result or error, and proceeds as though
// nothing happened.
IO.probe = function (fn) {
    return function tap_(M, input, success, failure) {
        try {
            fn(input);
        } catch (e) {
            // Stay quiet.
            console.error("tap exception!");
        }
        M.call(success, input, M.drain, failure);
    };
};

// A simple form of dynamic action. branches is an array
// of two-element arrays, where the first element
// gives the value to test against and the second
// element gives the action to choose.
//
// IO.cond([
//      ["one", IO.log("one"), ...],
//      ["two", IO.log("two"), ...],
//      ...
//      ]);
IO.cond = function (branches, defaultAction) {
    branches = branches.map(function (a) {
        return [patternMatcher(a[0]), autoseq(a.slice(1))];
    });

    var condError = defaultAction || IO.cond.error;

    return function cond_(M, input, success, failure) {
        var i, N, cond;
        for (i = 0, N = branches.length; i < N; ++i) {
            cond = branches[i];
            if (cond[0](input)) {
                M.call(cond[1], input, success, failure);
                return;
            }
        }

        M.call(condError, input, success, failure);
    };
};

IO.cond.true = function (_) { return true; };
IO.cond.false = function (_) { return false; };
IO.cond.error = IO.raise("cond failed!");

// Makes a pattern checker for the given object.
// If the object is a function, then it is assumed
// to be a pattern checker itself and is returned as is.
// If it is an object, then the returned function will
// check another object for presence of keys in this
// object ... recursively. Simple values are directly
// compared using ===.
function patternMatcher(fixed) {
    if (fixed instanceof Function) {
        return fixed;
    } else if (fixed instanceof Object && fixed.constructor === Object) {
        var keys = Object.keys(fixed);
        var matchers = keys.map(function (k) {
            return patternMatcher(fixed[k]);
        });
        var N = keys.length;

        return function (dyn) {
            if (dyn instanceof Object) {
                var i;
                for (i = 0; i < N; ++i) {
                    if (!((keys[i] in dyn) && matchers[i](dyn[keys[i]]))) {
                        return false;
                    }
                }
                return true;
            } else {
                return false;
            }
        };
    } else {
        return function (dyn) {
            return dyn === fixed;
        };
    }
}


// Waits for given milliseconds to pass on control to the next action
// in the sequence.
IO.delay = function (ms) {
    ms = Math.round(ms);
    return function delay_(M, input, success, failure) {
        M.delay(ms, success, input, M.drain, failure);
    };
};

// Debounces invocations of the following sequence.
// If requests keep coming in within the given "ms" interval,
// then the following actions will keep getting delayed
// until there is a grace period of at least "ms" milliseconds
// between requests.
IO.debounce = function (ms) {
    var lastRequestTime = Date.now();
    var lastRequestTimer;

    return function debounce_(M, input, success, failure) {
        var thisRequestTime = Date.now();
        if (lastRequestTimer && thisRequestTime - lastRequestTime < ms) {
            cancelTimeout(lastRequestTimer);
        }

        lastRequestTimer = setTimeout(function () { M.call(success, input, M.drain, failure); }, ms);
        lastRequestTime = thisRequestTime;
    };
};

function copyKeys(from, to) {
    var keys = Object.keys(from);
    keys.forEach(function (k) {
        to[k] = from[k];
    });
    return to;
}

// Adds the given key-value pairs to the data object
// at the point this action is given. Handy for inserting
// extra information into the pipeline.
IO.add = function (value) {
    return function add_(M, input, success, failure) {
        var merged = {};
        copyKeys(input, merged);
        copyKeys(value, merged);
        M.call(success, merged, M.drain, failure);
    };
};

// Similar to add, but replaces the data flowing at
// this point with the given value.
IO.supply = function (value) {
    return function supply_(M, input, success, failure) {
        M.call(success, value, M.drain, failure);
    };
};

// Applies the given function on the data flowing at this
// point and passes on what the function returns instead.
IO.map = function (fn) {
    return function map_(M, input, success, failure) {
        M.call(success, fn(input), M.drain, failure);
    };
};

// An action that will only let through those inputs
// that satisfy the given predicate.
IO.filter = function (pred) {
    return function filter_(M, input, success, failure) {
        M.call(pred(input) ? success : pass, input, M.drain, failure);
    };
};

// Applies the reduction function and generates the reduced
// result as each input arrives.
//
// reductionFn(accumulatedResult, value) -> new accumulated result
IO.reduce = function (reductionFn, initialValue) {
    var acc = initialValue;

    return function (M, input, success, failure) {
        M.call(success, acc = reductionFn(acc, input), M.drain, failure);
    };
};

// A value generator. The gen() function is expected to
// return a sequence of values every time it is called,
// and 'undefined' for end of the sequence. The generator
// captures PauseCondition and pauses/resumes automatically.
IO.gen = function (gen, delay_ms) {
    var paused = false;
    var genCount = 0;
    delay_ms = delay_ms || 0;

    function genOne_(M, input, success, failure) {
        if (genCount === 0) {
            genCount = M.kBufferCapacity;
        }

        if (!paused) {
            var value = gen();
            --genCount;
            if (value !== undefined) {
                M.call(success, value, M.drain, failure);
                if (!paused) {
                    if (genCount === 0) {
                        M.delay(delay_ms, genOne_, input, success, failure);
                    } else {
                        genOne_(M, input, success, failure);
                    }
                }
            }
        }
    }


    function gen_(M, input, success, failure) {
        var catcher = IO.catch(function (error, resume, giveup) {
            if (error instanceof IOPauseCondition) {
                if (!paused) {
                    paused = true;
                    if (error.onresume) {
                        error.onresume(function () {
                            paused = false;
                            M.call(gen_, input, success, failure);
                        });
                    }
                }
            } else {
                giveup(error);
            }
        });

        M.call(seq(catcher, genOne_), input, success, failure);
    }

    return gen_;
};

// An action useful to "pause" generators forever.
IO.pause = function (M, input, success, failure) {
    M.call(failure, new IOPauseCondition(), M.drain, M.drain);
};

// Triggers the following actions once for each value in the array.
// The order of execution is not guaranteed to be the same as the
// array element order. If you want the same order of execution,
// just wrap the rest in an IO.atomic or IO.pipeline as desired.
//
// If no array argument is given, then the input will be sprayed.
IO.spray = function (array) {
    function gen(array) {
        var i = 0;
        return function array_enumerator_() {
            if (i < array.length) {
                return array[i++];
            } else {
                return undefined;
            }
        };
    }

    return function (M, input, success, failure) {
        M.call(IO.gen(gen(array || input)), input, success, failure);
    };
};

// Triggers the following actions once for each value in the array.
// The order of execution is not guaranteed to be the same as the
// array element order. If you want the same order of execution,
// just wrap the rest in an IO.atomic or IO.pipeline as desired.
//
// If no array argument is given, then the input will be sprayed.
IO.cycle = function (array) {
    function gen(array) {
        var i = 0;
        return function array_enumerator_() {
            var j = i % array.length;
            i = (i + 1) % array.length;
            return array[j];
        };
    }

    return function (M, input, success, failure) {
        M.call(IO.gen(gen(array || input)), input, success, failure);
    };
};


// Generates a numeric sequence starting from `from`,
// incrementing by `step` until `to` is reached. If
// `to` is not specified, then the sequence is infinite.
// `from` and `step` default to 0 and 1 respectively.
IO.enumFrom = function (from, step, to) {
    from = from || 0;
    step = step || 1;

    var gen = (function () {
        if (to === undefined) {
            return function () {
                var i = from;
                return function (j) { return (j = i, i += step, j); };
            };
        } else if (step > 0) {
            return function () {
                var i = from;
                return function (j) { return i < to ? (j = i, i += step, j) : undefined; };
            };
        } else if (step < 0) {
            return function () {
                var i = from;
                return function (j) { return i > to ? (j = i, i += step, j) : undefined; };
            };
        }
    }());

    return function (M, input, success, failure) {
        M.call(IO.gen(gen()), input, success, failure);
    };
};

// Collects in-flowing values into an array. Continues
// the sequence passing the collected array every time an
// item is received. If you pass a test function, it will 
IO.collectUntil = function (test) {
    var acc = [];

    if (test) {
        return function (M, input, success, failure) {
            if (test(input)) {
                M.call(M.drain, acc, M.drain, failure);
            } else {                
                acc.push(input);
                M.call(success, acc, M.drain, failure);
            }
        };
    } else {
        return function (M, input, success, failure) {
            if (input === undefined) {
                M.call(M.drain, acc, M.drain, failure);
            } else {
                acc.push(input);
                M.call(success, acc, M.drain, failure);
            }
        };
    }
};

// Makes a new "channel" that can be used to communicate between two
// sequences running in different orchestrators or forks. The channel
// has two fields named 'send' and 'recv' which are actions that can
// be inserted into any sequence to achieve the necessary coordination.
IO.chan = function () {
    var waiters = [];
    var queue = [];
    
    function flush() {
        var count = 0;
        while (queue.length > 0 && waiters.length > 0) {
            waiters.shift()(queue.shift());
            ++count;
        }
        return count;
    }

    return {
        send: function send_chan(M, input, success, failure) {
            queue.push(input);
            flush();
            M.call(success, input, M.drain, failure);
        },
        recv: function recv_chan(M, input, success, failure) {
            flush();
            if (queue.length === 0) {
                waiters.push(function (data) {
                    M.delay(0, success, data, M.drain, failure);
                });
            } else {
                M.call(success, queue.shift(), M.drain, failure);
            }
        }
    };
};

// Turns the action into a "FIFO" pipe, forcing all invocations
// to process inputs in serial order. This could be useful in
// a variety of circumstances where you don't want the intermediate
// steps involved in the action to be active in more than one "thread".
IO.atomic = function (action) {
    action = autoseq(actionArray(arguments));

    var arr = [];
    var busy = false;
    var pauseStream;

    function doit(M, input, succ, fail) {
        if (!busy) {
            busy = true;
            M.call(seq(action, done), input, succ, fail);
        } else if (M.kBufferCapacity && arr.length + 1 >= M.kBufferCapacity) {
            arr.push([input, succ, fail]);
            pauseStream = pauseStream || new IOPauseCondition();
            M.call(fail, pauseStream, M.drain, M.drain);
        } else {
            arr.push([input, succ, fail]);
        }
    }

    function done(M, output, succ, fail) {
        if (arr.length > 0) {
            var x = arr.shift();
            M.call(seq(action, done), x[0], x[1], x[2]);
            if (pauseStream && arr.length < M.kBufferCapacity) {
                var s = pauseStream;
                pauseStream = undefined;
                s.resume();
            }
        } else {
            busy = false;
        }
        M.call(succ, output, M.drain, fail);
    }
    
    return doit;
};

function mappableAtomic(action) {
    return IO.atomic(action);
}

// IO.pipeline(a1, a2, ...)
//  = IO.pipeline([a1, a2, ...]) 
//  = IO.do([a1, a2, ...].map(IO.atomic))
//
// Creates a "pipeline" where each action is turned into a FIFO processor
// by attaching an input queue to it. You typically pump actions to a 
// pipeline using multiple IO.run calls.
//
// You can also make a pipeline a part of other "host" action sequences.
// In such cases, the host action sequences will only receive the output
// corresponding to the inputs that they sent and not those by any other.
IO.pipeline = function (actions) {
    return IO.do(actionArray(arguments).map(mappableAtomic));
};

// Makes a clock action that behaves as follows -
// 
// When it receives "start" as its input, it starts periodically
// triggering the actions that follow. The value that it sends
// to them is determined by `tickFn(i)` where `i` is the i-th
// tick number of the clock, with the first tick number being 0.
// 
// When it receives "stop" as its input, it stops ticking.
// 
// When it receives "reset", the tick number is reset to 0 for
// the next tick.
//
// All other inputs are ignored.
//
// To make an action trigger periodically, you snap a clock
// to its front and send the whole composite action a "start"
// message, like so -
//
//      var periodicAction = IO.do(IO.clock(1000), someAction);
//      IO.run("start", periodicAction);
//
// To stop the periodic action that's running, do this -
//      IO.run("stop", periodicAction);
//
// Note that if the remaining steps take longer than the clock
// period, then you'll end up piling up work pretty quickly.
// So this kind of scheduling of actions is to be used only
// in cases where you know that the actions will complete in
// a much shorter interval than a clock period.
IO.clock = function (period_ms, tickFn) {
    var tickNumber = 0;
    var ticking = false;

    tickFn = tickFn || function (i) { return i; };

    function tick(M, input, success, failure) {
        if (ticking) {
            M.call(success, tickFn(tickNumber++), M.drain, failure);
            M.delay(period_ms, tick, null, success, failure);
        }
    }

    return function clock_(M, input, success, failure) {
        if (input === "reset") {
            tickNumber = 0;
        }

        if (ticking) {
            if (input === "stop") {
                ticking = false;
            } 
        } else {
            if (input === "start") {
                ticking = true;
                M.delay(0, tick, tickNumber, success, failure);
            }
        }
    };
};

// LOgs the given message string, but is otherwise a no-op.
IO.log = function (msg, inputAlso) {
    return function log_(M, input, success, failure) {
        if (inputAlso) {
            console.log(msg + defaultInspector(input));
        } else {
            console.log(msg);
        }
        M.call(success, input, M.drain, failure);
    };
};


// IO.Ex is the main execution orchestrator. You run
// actions by calling IO.Ex.run(input, action).
IO.Ex = ExM;

// The error class is exposed.
IO.Error = IOError; // A recoverable error.
IO.PauseCondition = IOPauseCondition;   // A non-resumable condition
                                        // raised primarily to pause
                                        // generators. Other handlers
                                        // may ignore and propagate it.

//////////////////////
// Tracer

var defaultInspector = (function () {
    try {
        return require('util').inspect;
    } catch (e) {
        return JSON.stringify;
    }
}());

// The tracing orchestrator will log all steps to the
// console as they occur. Usage is exactly like IO.Ex.
// It has an extra delay(ms) method (which returns IO.Tracer)
// that you can use to give a pause on each call.
IO.Tracer = function (M) {

    M = M || IO.Ex;
    var T = Object.create(M);

    T.inspect = defaultInspector;

    T.call = function (action, input, success, failure) {
        var M = this;
        if (M.depth++ < M.maxdepth) {
            try {
                if (action.name && action.name.length > 0) {
                    console.log("trace:\t" + action.name.replace("_", "") + '(' + T.inspect(input) + ')');
                }
                action(M, input, success || M.drain, failure || M.drain);
            } catch (e) {
                console.error("trace:\t" + e);
                if (failure) {
                    try {
                        console.error("trace:\t" + failure.name + '(' + e + ')');
                        failure(M, e, M.drain, M.drain);
                    } catch (e2) {
                        console.error("trace:\t" + "failure handler failed with " + e2);
                    }
                }
            }
        } else {
            nextTick(function () {
                M.depth = Math.min(0, M.maxdepth - 1);
                M.call(action, input, success, failure);
            });
        }
    };

    T.drain = function (_, input, success, failure) {
        console.log("trace:\t\t" + input + " => drain");
        M.drain(T, input, success, failure);
    };


    return T;
};

///////////////////////////////////////
// Aliases for common cases.

IO.run = function (input, action) {
    ExM.run(input, action);
};

// IO.trace(a1, a2, ...) 
// IO.trace([a1, a2, ...])
//      => action which prints out steps as it runs.
IO.trace = function (actions) {
    var action = autoseq(actionArray(arguments));
    return function (M, input, success, failure) {
        IO.Tracer(M).call(action, input, success, failure);
    };
};

try {
    // Check whether we're in Node.js
    module.exports = IO;
} catch (e) {
    // Export IO as global symbol.
    (function () {
        this.IO = IO;
    }());
}

}({}));

