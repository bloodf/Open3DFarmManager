// Functions evaluated inside the browser page by verify.mjs.
// Each must be self-contained: Playwright serialises it into the page.

/** Structure: language, title, single h1, landmarks, alt text, unique ids. */
export function inspectStructure() {
  const problems = []
  const doc = document
  if (doc.documentElement.lang !== 'pt-BR')
    problems.push('html lang must be pt-BR')
  if (!doc.title.trim()) problems.push('missing <title>')
  if (doc.querySelectorAll('h1').length !== 1)
    problems.push('page needs exactly one <h1>')
  for (const [selector, name] of [
    ['body > header', 'banner header'],
    ['main#conteudo', 'main landmark'],
    ['body > footer', 'contentinfo footer'],
    ['nav[aria-label="Principal"]', 'primary nav'],
  ]) {
    if (!doc.querySelector(selector)) problems.push(`missing ${name}`)
  }
  const ids = [...doc.querySelectorAll('[id]')].map((el) => el.id)
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    problems.push(`duplicate id #${id}`)
  }
  let previous = 0
  for (const heading of doc.querySelectorAll('h1,h2,h3,h4')) {
    const level = Number(heading.tagName[1])
    if (previous && level > previous + 1) {
      problems.push(
        `heading level skips from h${previous} to h${level}: ${heading.textContent.trim().slice(0, 40)}`,
      )
    }
    previous = level
  }
  for (const img of doc.querySelectorAll('img')) {
    const alt = img.getAttribute('alt')
    if (alt === null || !alt.trim())
      problems.push(`img without alt text: ${img.getAttribute('src')}`)
    if (!img.complete || img.naturalWidth === 0)
      problems.push(`img failed to load: ${img.getAttribute('src')}`)
    if (
      img.naturalWidth &&
      Number(img.getAttribute('width')) !== img.naturalWidth
    ) {
      problems.push(
        `img width attribute differs from file: ${img.getAttribute('src')}`,
      )
    }
    if (
      img.naturalHeight &&
      Number(img.getAttribute('height')) !== img.naturalHeight
    ) {
      problems.push(
        `img height attribute differs from file: ${img.getAttribute('src')}`,
      )
    }
  }
  for (const a of doc.querySelectorAll('a[href^="#"]')) {
    const target = a.getAttribute('href').slice(1)
    if (target && !doc.getElementById(target))
      problems.push(`broken in-page link ${a.getAttribute('href')}`)
  }
  for (const el of doc.querySelectorAll('[aria-labelledby]')) {
    for (const id of el.getAttribute('aria-labelledby').split(/\s+/)) {
      if (!doc.getElementById(id))
        problems.push(`aria-labelledby points to missing #${id}`)
    }
  }
  return problems
}

/** Horizontal overflow of the page and of any unclipped element. */
export function inspectOverflow() {
  const width = window.innerWidth
  const problems = []
  const root = document.documentElement
  if (root.scrollWidth > width)
    problems.push(`page scrolls horizontally (${root.scrollWidth} > ${width})`)
  const clipped = (el) => {
    for (
      let node = el.parentElement;
      node && node !== document.body;
      node = node.parentElement
    ) {
      if (getComputedStyle(node).overflowX !== 'visible') return true
    }
    return false
  }
  for (const el of document.body.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if ((rect.right > width + 0.5 || rect.left < -0.5) && !clipped(el)) {
      problems.push(
        `overflow: <${el.tagName.toLowerCase()} class="${el.className}"> spans ${Math.round(rect.left)}..${Math.round(rect.right)} of ${width}`,
      )
      if (problems.length > 8) break
    }
  }
  return problems
}

/** Page background luminance, to confirm light or dark really applied. */
export function backgroundLuminance() {
  const [r, g, b] = getComputedStyle(document.body)
    .backgroundColor.match(/[\d.]+/g)
    .slice(0, 3)
    .map((v) => {
      const c = Number(v) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Tag every focusable, visible element in DOM order and return the tags. */
export function tagFocusables() {
  const selector =
    'a[href],button:not([disabled]),summary,input,select,textarea,[tabindex]:not([tabindex="-1"])'
  const visible = (el) => {
    const style = getComputedStyle(el)
    const closedDetails =
      el.tagName !== 'SUMMARY' && el.closest('details:not([open])')
    return (
      el.getClientRects().length > 0 &&
      style.visibility !== 'hidden' &&
      !closedDetails
    )
  }
  return [...document.querySelectorAll(selector)]
    .filter(visible)
    .map((el, index) => {
      el.dataset.verifyFocus = String(index)
      return {
        index,
        label: `${el.tagName.toLowerCase()} ${(el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40)}`,
      }
    })
}

/** Describe the focused element: its tag and whether focus is visibly drawn. */
export function describeFocus() {
  const el = document.activeElement
  if (!el || el === document.body) return null
  const style = getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  const outlineWidth = parseFloat(style.outlineWidth) || 0
  const hasOutline = style.outlineStyle !== 'none' && outlineWidth >= 2
  const hasShadow = style.boxShadow !== 'none'
  // A skip link is moved on screen on focus; elsewhere the element must be in view.
  const inView =
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  return {
    tag: el.dataset.verifyFocus ?? null,
    id: el.id,
    visibleFocus: hasOutline || hasShadow,
    inView,
  }
}

/** Longest animation or transition declared on any element. */
export function longestMotion() {
  const toSeconds = (list) =>
    list
      .split(',')
      .map((v) =>
        v.trim().endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v) || 0,
      )
  let longest = 0
  for (const el of document.querySelectorAll('*')) {
    const style = getComputedStyle(el)
    const animates = style.animationName !== 'none'
    const values = [
      ...toSeconds(style.transitionDuration),
      ...(animates ? toSeconds(style.animationDuration) : [0]),
    ]
    longest = Math.max(longest, ...values)
  }
  return {
    longest,
    scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
  }
}
