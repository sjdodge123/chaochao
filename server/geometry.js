"use strict";
// Shared 2D segment geometry. A leaf module (requires nothing) so both the engine
// (player collision: stone seams + barriers) and cellGraph (bot pathing: barrier
// edge cuts) share ONE implementation instead of each keeping a private copy.

function sideOf(ax, ay, bx, by, px, py) {
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}
// Whether segments p0->p1 and p2->p3 properly intersect (standard cross-product test).
function segmentsCross(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y) {
    var d1 = sideOf(p2x, p2y, p3x, p3y, p0x, p0y);
    var d2 = sideOf(p2x, p2y, p3x, p3y, p1x, p1y);
    var d3 = sideOf(p0x, p0y, p1x, p1y, p2x, p2y);
    var d4 = sideOf(p0x, p0y, p1x, p1y, p3x, p3y);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

// The point where segment p0->p1 crosses segment p2->p3, with `t` the fraction along
// p0->p1 (0 at p0, 1 at p1), or null if they don't cross within both segments. The
// POINT-returning cousin of segmentsCross (same parametric convention) — callers that
// need to stop a projectile / line-of-sight AT the crossing use this.
function segmentIntersectionPoint(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y) {
    var rx = p1x - p0x, ry = p1y - p0y;
    var sx = p3x - p2x, sy = p3y - p2y;
    var denom = rx * sy - ry * sx;
    if (denom < 1e-9 && denom > -1e-9) { return null; } // parallel / degenerate
    var t = ((p2x - p0x) * sy - (p2y - p0y) * sx) / denom;
    var u = ((p2x - p0x) * ry - (p2y - p0y) * rx) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) { return null; }
    return { x: p0x + rx * t, y: p0y + ry * t, t: t };
}

exports.sideOf = sideOf;
exports.segmentsCross = segmentsCross;
exports.segmentIntersectionPoint = segmentIntersectionPoint;
