import type { IconDefinition } from '@fortawesome/free-solid-svg-icons'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 依存に既にある Font Awesome の形を、殻の SVG にする。新しい依存とライセンスを増やさない。
 * 色は文字の色（currentColor）、大きさは CSS が決める。読み上げには出さない飾り。
 */
export function createIcon(definition: IconDefinition): SVGSVGElement {
  const [width, height, , , pathData] = definition.icon
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('class', 'app-icon')
  for (const data of Array.isArray(pathData) ? pathData : [pathData]) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', data)
    path.setAttribute('fill', 'currentColor')
    svg.appendChild(path)
  }
  return svg
}
