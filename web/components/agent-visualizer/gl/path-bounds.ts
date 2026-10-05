/**
 * Where a Path2D's drawing lies, in its own units: the GPU context draws a path it can't read into
 * a picture of this box. Set by whoever makes the path
 */
export const pathBounds = new WeakMap<Path2D, readonly [number, number, number, number]>()
