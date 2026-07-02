/**
 * background logics for RemotePageController
 * - redirect messages from RemotePageController(Agent, extension pages) to ContentScript
 * - @edit Support multi-frame routing: messages can target a specific frameId
 */

/** Frame info from webNavigation.getAllFrames */
export interface FrameInfo {
	frameId: number
	parentFrameId: number
	url: string
}

/**
 * Get all frames in a tab.
 * @edit New function for multi-frame support.
 */
export async function getAllFrames(tabId: number): Promise<FrameInfo[] | null> {
	try {
		const frames = await chrome.webNavigation.getAllFrames({ tabId })
		if (!frames) return null
		return frames.map((f) => ({
			frameId: f.frameId,
			parentFrameId: f.parentFrameId,
			url: f.url,
		}))
	} catch (e) {
		console.error('[RemotePageController.background] getAllFrames failed:', e)
		return null
	}
}

export function handlePageControlMessage(
	message: {
		type: 'PAGE_CONTROL'
		action: string
		payload: any
		targetTabId: number
		/** @edit Optional frameId to route message to a specific frame */
		frameId?: number
	},
	sender: chrome.runtime.MessageSender,
	sendResponse: (response: unknown) => void
): true | undefined {
	const PREFIX = '[RemotePageController.background]'

	const debug = console.debug.bind(console, `\x1b[90m${PREFIX}\x1b[0m`)

	const { action, payload, targetTabId, frameId } = message

	if (action === 'get_my_tab_id') {
		debug('get_my_tab_id', sender.tab?.id)
		sendResponse({ tabId: sender.tab?.id || null })
		return
	}

	// @edit New action: enumerate all frames in the tab
	if (action === 'get_all_frames') {
		getAllFrames(targetTabId).then((frames) => {
			sendResponse({ frames })
		})
		return true
	}

	// @edit: If frameId is specified, route to that specific frame.
	// Otherwise, sendMessage goes to the top-level frame only (default behavior).
	const sendOptions: chrome.tabs.MessageSendOptions = frameId !== undefined
		? { frameId }
		: {}

	// proxy to content script
	chrome.tabs
		.sendMessage(targetTabId, {
			type: 'PAGE_CONTROL',
			action,
			payload,
		}, sendOptions)
		.then((result) => {
			sendResponse(result)
		})
		.catch((error) => {
			console.error(PREFIX, error)
			sendResponse({
				success: false,
				error: error instanceof Error ? error.message : String(error),
			})
		})

	return true // async response
}
