// ======= type guards =======
// @note instanceof fails for elements inside iframes

export function isHTMLElement(el: unknown): el is HTMLElement {
	// @todo either specify to HTMLElement or allow Element here.
	return !!el && (el as Node).nodeType === 1
}

export function isInputElement(el: Element): el is HTMLInputElement {
	return el?.nodeType === 1 && el.tagName === 'INPUT'
}

export function isTextAreaElement(el: Element): el is HTMLTextAreaElement {
	return el?.nodeType === 1 && el.tagName === 'TEXTAREA'
}

export function isSelectElement(el: Element): el is HTMLSelectElement {
	return el?.nodeType === 1 && el.tagName === 'SELECT'
}

export function isAnchorElement(el: Element): el is HTMLAnchorElement {
	return el?.nodeType === 1 && el.tagName === 'A'
}

// ======= iframe helpers =======

/**
 * Iframe offset for translating element coordinates to top-frame viewport.
 * @edit Recursively accumulate offsets for nested iframes (A→B→element).
 *       Previously only handled a single iframe level, causing highlight
 *       labels and click coordinates to be misaligned in nested-iframe pages.
 */
export function getIframeOffset(element: HTMLElement): { x: number; y: number } {
	let offsetX = 0
	let offsetY = 0
	let currentDoc = element.ownerDocument

	// Walk up through every ancestor frame until we reach the top document.
	while (currentDoc && currentDoc !== window.document) {
		const frame = currentDoc.defaultView?.frameElement as HTMLElement | null
		if (!frame) break
		const rect = frame.getBoundingClientRect()
		offsetX += rect.left
		offsetY += rect.top
		currentDoc = frame.ownerDocument // ascend one level
	}

	return { x: offsetX, y: offsetY }
}

/**
 * Get native value setter from the element's own prototype (iframe-safe).
 * @note for React
 */
export function getNativeValueSetter(element: HTMLInputElement | HTMLTextAreaElement) {
	// eslint-disable-next-line @typescript-eslint/unbound-method
	return Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element) as object, 'value')!
		.set as (v: string) => void
}

// ======= general utils =======

export async function waitFor(seconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

// ======= mask events =======
// @edit: In multi-frame mode (allFrames: true), each frame's content script
// has its own window. SimulatorMask lives in the top frame, so mask-related
// events must also be dispatched to window.top for the mask to react.

/**
 * Dispatch a CustomEvent to both the current window and the top window.
 * When running inside an iframe, the top frame's SimulatorMask needs
 * these events to coordinate mask state (pass-through, cursor animation).
 */
function dispatchToTopAndSelf(event: CustomEvent): void {
	window.dispatchEvent(event)
	if (window.top && window.top !== window) {
		try {
			window.top.dispatchEvent(event)
		} catch (e) {
			// Cross-origin window.top may throw — ignore, same-origin works
		}
	}
}

/**
 * Move the visual pointer to a position within an element.
 * @param x - x coordinate in the element's document viewport
 * @param y - y coordinate in the element's document viewport
 */
export async function movePointerToElement(element: HTMLElement, x: number, y: number) {
	const offset = getIframeOffset(element)

	dispatchToTopAndSelf(
		new CustomEvent('PageAgent::MovePointerTo', {
			detail: { x: x + offset.x, y: y + offset.y },
		})
	)

	await waitFor(0.3)
}

export async function clickPointer() {
	dispatchToTopAndSelf(new CustomEvent('PageAgent::ClickPointer'))
}

export async function enablePassThrough() {
	dispatchToTopAndSelf(new CustomEvent('PageAgent::EnablePassThrough'))
}

export async function disablePassThrough() {
	dispatchToTopAndSelf(new CustomEvent('PageAgent::DisablePassThrough'))
}
