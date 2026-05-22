// Debug logging for the server. Flip `enabled` to true to turn on. Defaults to false.
exports.enabled = false;
exports.log = function () {
    if (!exports.enabled) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[debug]");
    console.log.apply(console, args);
};

// DEBUG: force every round to be a brutal blackout round for testing.
// Defaults to false.
exports.forceBlackout = false;
