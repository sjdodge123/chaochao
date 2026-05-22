// Debug logging for the server. Flip `enabled` to true to turn on. Defaults to false.
exports.enabled = false;
exports.log = function () {
    if (!exports.enabled) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[debug]");
    console.log.apply(console, args);
};
