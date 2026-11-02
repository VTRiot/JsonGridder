// jsdom has no layout, and its Range lacks getClientRects and getBoundingClientRect. CodeMirror
// calls them when it measures, and a measure that throws leaves the text unrendered, so a test
// that looks for the text fails only when a measure happens to run. Empty rectangles are what
// a layout-free document would report.
const emptyRect = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) }

if (typeof Range !== 'undefined') {
  Range.prototype.getClientRects ??= function getClientRects(): DOMRectList {
    const list = Object.assign([], { item: () => null })
    return list as unknown as DOMRectList
  }
  Range.prototype.getBoundingClientRect ??= function getBoundingClientRect(): DOMRect {
    return emptyRect as DOMRect
  }
}
