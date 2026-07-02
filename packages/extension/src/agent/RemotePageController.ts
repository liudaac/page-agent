import type { BrowserState } from '@page-agent/page-controller'

import type { TabsController } from './TabsController'

const PREFIX = '[RemotePageController]'

const debug = console.debug.bind(console, `\x1b[90m${PREFIX}\x1b[0m`)

/** @edit Frame information */
interface FrameInfo {
	frameId: number
	parentFrameId: number
	url: string
}

/** @edit Global index → { frameId, localIndex } routing entry */
interface IndexRoute {
	frameId: number
	localIndex: number
}

function sendMessage(message: {
	type: 'PAGE_CONTROL'
	action: string
	targetTabId: number
	payload?: any
	/** @edit Optional frameId for multi-frame routing */
	frameId?: number
}): Promise<any> {
	return chrome.runtime.sendMessage(message).catch((error) => {
		console.error(PREFIX, message.action, error)
		return null
	})
}

/**
 * Agent side page controller.
 * - live in the agent env (extension page or content script)
 * - communicates with remote PageController via sw
 * - @edit Supports multi-frame: enumerates all frames in the tab, merges
 *   their browser states with global index offsets, and routes actions
 *   to the correct frame based on the global index.
 */
export class RemotePageController {
	tabsController: TabsController

	/** @edit Global index → { frameId, localIndex } routing table */
	private indexRouteMap = new Map<number, IndexRoute>()

	/** @edit Cached frame list for the current tab */
	private cachedFrames: FrameInfo[] | null = null

	/**
	 * @edit Track the frameId of the most recent index-based action.
	 * send_keys (which has no index) uses this to route to the correct frame.
	 */
	private lastActionFrameId: number | undefined = undefined

	constructor(tabsController: TabsController) {
		this.tabsController = tabsController
	}

	get currentTabId(): number | null {
		return this.tabsController.currentTabId
	}

	private async getCurrentUrl(): Promise<string> {
		if (!this.currentTabId) return ''
		const { url } = await this.tabsController.getTabInfo(this.currentTabId)
		return url || ''
	}

	private async getCurrentTitle(): Promise<string> {
		if (!this.currentTabId) return ''
		const { title } = await this.tabsController.getTabInfo(this.currentTabId)
		return title || ''
	}

	/**
	 * @edit Enumerate all frames in the current tab.
	 * Returns [{ frameId, parentFrameId, url }, ...].
	 * Falls back to [{ frameId: 0 }] if webNavigation is unavailable.
	 */
	private async getAllFrames(): Promise<FrameInfo[]> {
		if (!this.currentTabId) return [{ frameId: 0, parentFrameId: -1, url: '' }]

		try {
			const result = await chrome.runtime.sendMessage({
				type: 'PAGE_CONTROL',
				action: 'get_all_frames',
				targetTabId: this.currentTabId,
			})
			if (result?.frames && Array.isArray(result.frames) && result.frames.length > 0) {
				this.cachedFrames = result.frames
				return result.frames as FrameInfo[]
			}
		} catch (e) {
			console.warn(PREFIX, 'getAllFrames failed, falling back to top frame only:', e)
		}

		// Fallback: just the top frame
		const url = await this.getCurrentUrl()
		return [{ frameId: 0, parentFrameId: -1, url }]
	}

	async getLastUpdateTime(): Promise<number> {
		if (!this.currentTabId) throw new Error('tabsController not initialized.')
		return sendMessage({
			type: 'PAGE_CONTROL',
			action: 'get_last_update_time',
			targetTabId: this.currentTabId,
		})
	}

	/**
	 * @edit Multi-frame getBrowserState.
	 * Enumerates all frames, fetches browser state from each, merges with
	 * global index offsets.
	 */
	async getBrowserState(): Promise<BrowserState> {
		let browserState: BrowserState
		debug('getBrowserState', this.currentTabId)

		const currentUrl = await this.getCurrentUrl()
		const currentTitle = await this.getCurrentTitle()

		if (!this.currentTabId || !isContentScriptAllowed(currentUrl)) {
			browserState = {
				url: currentUrl,
				title: currentTitle,
				header: '',
				content: '(empty page. either current page is not readable or not loaded yet.)',
				footer: '',
			}
		} else {
			// @edit: Get all frames and fetch state from each
			const frames = await this.getAllFrames()

			if (frames.length <= 1) {
				// Single frame (no iframes) — use original behavior
				browserState = await sendMessage({
					type: 'PAGE_CONTROL',
					action: 'get_browser_state',
					targetTabId: this.currentTabId,
				})
			} else {
				// Multi-frame: fetch state from each frame in parallel
				browserState = await this.getMultiFrameBrowserState(frames, currentUrl, currentTitle)
			}
		}

		const sum = await this.tabsController.summarizeTabs()
		browserState.header = sum + '\n\n' + (browserState.header || '')

		debug('getBrowserState: success', this.currentTabId, browserState)

		return browserState
	}

	/**
	 * @edit Fetch browser state from multiple frames and merge them.
	 * Each frame's local indices [N] are remapped to global indices [N + offset].
	 */
	private async getMultiFrameBrowserState(
		frames: FrameInfo[],
		currentUrl: string,
		currentTitle: string
	): Promise<BrowserState> {
		this.indexRouteMap.clear()

		// @edit: Removed fixed OFFSET_PER_FRAME=1000. Instead, dynamically
		// accumulate offset based on the actual number of indices in each
		// frame, plus a small gap to avoid boundary collisions.

		// Sort: top frame (frameId=0) first, then by frameId
		const sortedFrames = [...frames].sort((a, b) => {
			if (a.frameId === 0) return -1
			if (b.frameId === 0) return 1
			return a.frameId - b.frameId
		})

		// Fetch state from each frame in parallel
		const frameResults = await Promise.all(
			sortedFrames.map(async (frame) => {
				try {
					const state = await sendMessage({
						type: 'PAGE_CONTROL',
						action: 'get_browser_state',
						targetTabId: this.currentTabId!,
						frameId: frame.frameId,
					})
					return { frame, state: state as BrowserState | null }
				} catch (e) {
					debug(`Failed to get state from frame ${frame.frameId}:`, e)
					return { frame, state: null }
				}
			})
		)

		// Merge states with index remapping
		const contentParts: string[] = []
		let globalOffset = 0
		let topHeader = ''
		let topFooter = ''

		for (const { frame, state } of frameResults) {
			if (!state || !state.content || state.content.startsWith('(empty')) {
				continue
			}

			// Use the top frame's header/footer
			if (frame.frameId === 0) {
				topHeader = state.header || ''
				topFooter = state.footer || ''
			}

			// Remap indices: [N] → [N + offset]
			const { text, indices } = this.remapIndices(state.content, globalOffset)

			if (indices.length > 0) {
				// Add a label for iframe content so the LLM knows the context
				const frameLabel = frame.frameId === 0
					? ''
					: `\n<!-- iframe content (frame ${frame.frameId}, url: ${frame.url}) -->\n`

				contentParts.push(frameLabel + text)

				// Record routing entries
				for (const { globalIndex, localIndex } of indices) {
					this.indexRouteMap.set(globalIndex, {
						frameId: frame.frameId,
						localIndex,
					})
				}

				// @edit: Advance offset by the actual number of indices found,
				// plus a 10-element gap to prevent off-by-one collisions.
				const maxLocalIndex = indices.reduce(
					(max, idx) => Math.max(max, idx.localIndex),
					0
				)
				globalOffset += maxLocalIndex + 10
			}
		}

		return {
			url: currentUrl,
			title: currentTitle,
			header: topHeader,
			content: contentParts.join('\n'),
			footer: topFooter,
		}
	}

	/**
	 * @edit Remap local indices [N] in frame content to global indices [N + offset].
	 * Returns the remapped text and a list of { globalIndex, localIndex } pairs.
	 */
	private remapIndices(
		content: string,
		offset: number
	): {
		text: string
		indices: { globalIndex: number; localIndex: number }[]
	} {
		const indices: { globalIndex: number; localIndex: number }[] = []

		// @edit: Only match index markers like [N]<tag or *[N]<tag.
		// The previous regex /(\*?)\[(\d+)\]/g would also match [0] inside
		// element text content (e.g. "Array index [0] is the first element").
		// By requiring < after the bracket, we only match actual element markers.
		const text = content.replace(
			/(\*?)\[(\d+)\]</g,
			(_match, star: string, numStr: string) => {
				const localIndex = parseInt(numStr, 10)
				const globalIndex = localIndex + offset
				indices.push({ globalIndex, localIndex })
				return `${star}[${globalIndex}]<`
			}
		)

		return { text, indices }
	}

	async updateTree(): Promise<void> {
		if (!this.currentTabId || !isContentScriptAllowed(await this.getCurrentUrl())) {
			return
		}

		// @edit: Update tree in all frames (non-fatal if some fail)
		const frames = this.cachedFrames || [{ frameId: 0, parentFrameId: -1, url: '' }]

		await Promise.all(
			frames.map(async (frame) => {
				try {
					await sendMessage({
						type: 'PAGE_CONTROL',
						action: 'update_tree',
						targetTabId: this.currentTabId!,
						frameId: frame.frameId,
					})
				} catch (e) {
					// Non-fatal: some frames may not have content scripts
				}
			})
		)
	}

	async cleanUpHighlights(): Promise<void> {
		if (!this.currentTabId || !isContentScriptAllowed(await this.getCurrentUrl())) {
			return
		}

		// @edit: Clean up highlights in all frames
		const frames = this.cachedFrames || [{ frameId: 0, parentFrameId: -1, url: '' }]

		await Promise.all(
			frames.map(async (frame) => {
				try {
					await sendMessage({
						type: 'PAGE_CONTROL',
						action: 'clean_up_highlights',
						targetTabId: this.currentTabId!,
						frameId: frame.frameId,
					})
				} catch (e) {
					// Non-fatal
				}
			})
		)
	}

	/**
	 * @edit Multi-frame click: look up the global index in the route map,
	 * then send the click action to the correct frame with the local index.
	 */
	async clickElement(...args: any[]): Promise<DomActionReturn> {
		const res = await this.remoteCallDomAction('click_element', args)
		// @note may cause page navigation, wait for 1 second to ensure the page loading started
		await new Promise((resolve) => setTimeout(resolve, 1000))
		return res
	}

	async inputText(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('input_text', args)
	}

	async selectOption(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('select_option', args)
	}

	async scroll(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('scroll', args)
	}

	async scrollHorizontally(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('scroll_horizontally', args)
	}

	/** @edit New: send_keys action */
	async sendKeys(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('send_keys', args)
	}

	/** @edit New: input_text_with_suggestion action */
	async inputTextWithSuggestion(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('input_text_with_suggestion', args)
	}

	// `execute_javascript` is intentionally not implemented: AbortSignal cannot cross context

	/** @note Managed by content script via storage polling. */
	async showMask(): Promise<void> {}
	/** @note Managed by content script via storage polling. */
	async hideMask(): Promise<void> {}
	/** @note Managed by content script via storage polling. */
	dispose(): void {}

	/**
	 * @edit Multi-frame aware action routing.
	 * For index-based actions, looks up the global index in indexRouteMap
	 * to find the correct frameId and local index.
	 */
	private async remoteCallDomAction(action: string, payload: any[]): Promise<DomActionReturn> {
		if (!this.currentTabId) {
			return { success: false, message: 'RemotePageController not initialized.' }
		}

		if (!isContentScriptAllowed(await this.getCurrentUrl())) {
			return {
				success: false,
				message:
					'Operation not allowed on this page. Use open_new_tab to navigate to a web page first.',
			}
		}

		// @edit: For index-based actions, resolve the frameId from the route map
		const INDEX_ACTIONS = [
			'click_element',
			'input_text',
			'select_option',
			'input_text_with_suggestion',
		]

		let frameId: number | undefined
		let adjustedPayload = payload

		if (INDEX_ACTIONS.includes(action) && payload.length > 0) {
			const globalIndex = payload[0] as number
			let route = this.indexRouteMap.get(globalIndex)

			// @edit: If the index is not in the route map, the page may have
			// changed since the last getBrowserState(). Refresh once and retry
			// before falling back to the top frame.
			if (!route && this.cachedFrames && this.cachedFrames.length > 1) {
				debug(`Index ${globalIndex} not in route map, refreshing browser state...`)
				await this.getBrowserState()
				route = this.indexRouteMap.get(globalIndex)
			}

			if (route) {
				frameId = route.frameId
				// Remember this frame for subsequent non-index actions (send_keys)
				this.lastActionFrameId = route.frameId
				// Replace global index with local index in the payload
				adjustedPayload = [route.localIndex, ...payload.slice(1)]
			} else {
				// Index still not found after refresh — fall back to top frame.
				// This covers single-frame mode where route map is not populated.
				frameId = undefined // default: top frame
				this.lastActionFrameId = undefined
			}
		}

		// For scroll actions with an index parameter, resolve the frame
		if ((action === 'scroll' || action === 'scroll_horizontally') && payload.length > 0) {
			const scrollPayload = payload[0] as any
			if (scrollPayload && typeof scrollPayload.index === 'number') {
				const globalIndex = scrollPayload.index
				const route = this.indexRouteMap.get(globalIndex)
				if (route) {
					frameId = route.frameId
					this.lastActionFrameId = route.frameId
					adjustedPayload = [
						{ ...scrollPayload, index: route.localIndex },
						...payload.slice(1),
					]
				}
			}
		}

		// @edit: send_keys has no index — route to the frame of the last
		// index-based action (where the focus element likely lives).
		if (action === 'send_keys') {
			frameId = this.lastActionFrameId
		}

		return sendMessage({
			type: 'PAGE_CONTROL',
			action: action,
			targetTabId: this.currentTabId!,
			payload: adjustedPayload,
			frameId,
		})
	}
}

interface DomActionReturn {
	success: boolean
	message: string
}

/**
 * Check if a URL can run content scripts.
 */
export function isContentScriptAllowed(url: string | undefined): boolean {
	if (!url) return false

	const restrictedPatterns = [
		/^chrome:\/\//,
		/^chrome-extension:\/\//,
		/^about:/,
		/^edge:\/\//,
		/^brave:\/\//,
		/^opera:\/\//,
		/^vivaldi:\/\//,
		/^file:\/\//,
		/^view-source:/,
		/^devtools:\/\//,
	]

	return !restrictedPatterns.some((pattern) => pattern.test(url))
}
