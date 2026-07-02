/**
 * content script for RemotePageController
 */
import { PageController } from '@page-agent/page-controller'

/** Message type for frame-aware page control */
interface PageControlMessage {
	type: 'PAGE_CONTROL'
	action: string
	payload?: any
	targetTabId?: number
	frameId?: number
}

export function initPageController() {
	let pageController: PageController | null = null
	let intervalID: number | null = null

	const myTabIdPromise = chrome.runtime
		.sendMessage({ type: 'PAGE_CONTROL', action: 'get_my_tab_id' })
		.then((response) => {
			return (response as { tabId: number | null }).tabId
		})
		.catch((error) => {
			console.error('[RemotePageController.ContentScript]: Failed to get my tab id', error)
			return null
		})

	// @edit: Detect if we're in a sub-frame (iframe).
	// Sub-frames never need the mask overlay — only the top frame shows it.
	// This avoids unnecessary mask initialization and DOM mutation in iframes.
	const isTopFrame = window.top === window

	function getPC(): PageController {
		if (!pageController) {
			pageController = new PageController({
				enableMask: false,
				viewportExpansion: 400,
			})
		}
		return pageController
	}

	intervalID = window.setInterval(async () => {
		// @edit: Batch all storage reads into one call to reduce overhead.
		// With allFrames:true, N iframes × 3 reads = 3N storage calls per tick.
		// Now it's N × 1 batched call.
		const { agentHeartbeat, isAgentRunning, currentTabId } =
			await chrome.storage.local.get([
				'agentHeartbeat',
				'isAgentRunning',
				'currentTabId',
			])

		const now = Date.now()
		const agentInTouch = typeof agentHeartbeat === 'number' && now - agentHeartbeat < 2_000

		const myTabId = await myTabIdPromise
		// @edit: Only the top frame should show/hide the mask.
		// Sub-frames just need to keep their PageController alive for
		// remote DOM operations, but never manage the mask.
		const shouldShowMask =
			isTopFrame && isAgentRunning && agentInTouch && currentTabId === myTabId

		if (shouldShowMask) {
			const pc = getPC()
			pc.initMask()
			await pc.showMask()
		} else {
			if (pageController) {
				if (isTopFrame) pageController.hideMask()
				pageController.cleanUpHighlights()
			}
		}

		if (!isAgentRunning && agentInTouch) {
			if (pageController) {
				pageController.dispose()
				pageController = null
			}
		}
	}, 500)

	chrome.runtime.onMessage.addListener((message, sender, sendResponse): true | undefined => {
		if (message.type !== 'PAGE_CONTROL') {
			// sendResponse({
			// 	success: false,
			// 	error: `[RemotePageController.ContentScript]: Invalid message type: ${message.type}`,
			// })
			return
		}

		const { action, payload } = message as PageControlMessage
		const methodName = getMethodName(action)

		const pc = getPC() as any

		switch (action) {
			case 'get_last_update_time':
			case 'get_browser_state':
			case 'update_tree':
			case 'clean_up_highlights':
			case 'click_element':
			case 'input_text':
			case 'select_option':
			case 'scroll':
			case 'scroll_horizontally':
			case 'execute_javascript':
			case 'send_keys':
			case 'input_text_with_suggestion':
				pc[methodName](...(payload || []))
					.then((result: any) => {
						// @edit: attach frameId to the response so the agent
						// can identify which frame produced this state
						if (typeof result === 'object' && result !== null) {
							result.__frameId = sender.frameId ?? 0
						}
						sendResponse(result)
					})
					.catch((error: any) =>
						sendResponse({
							success: false,
							error: error instanceof Error ? error.message : String(error),
							__frameId: sender.frameId ?? 0,
						})
					)
				break

			default:
				sendResponse({
					success: false,
					error: `Unknown PAGE_CONTROL action: ${action}`,
				})
		}

		return true
	})
}

function getMethodName(action: string): string {
	switch (action) {
		case 'get_last_update_time':
			return 'getLastUpdateTime' as const
		case 'get_browser_state':
			return 'getBrowserState' as const
		case 'update_tree':
			return 'updateTree' as const
		case 'clean_up_highlights':
			return 'cleanUpHighlights' as const

		// DOM actions

		case 'click_element':
			return 'clickElement' as const
		case 'input_text':
			return 'inputText' as const
		case 'select_option':
			return 'selectOption' as const
		case 'scroll':
			return 'scroll' as const
		case 'scroll_horizontally':
			return 'scrollHorizontally' as const
		case 'execute_javascript':
			return 'executeJavascript' as const

		// @edit: new actions for autocomplete/suggestion support
		case 'send_keys':
			return 'sendKeys' as const
		case 'input_text_with_suggestion':
			return 'inputTextWithSuggestion' as const

		default:
			return action
	}
}
