import * as extensionConfig from '../extension.json';

const SOLIDWORKS_WEBSOCKET_ID = 'solidworks-pcb-exporter';
const DEFAULT_SOLIDWORKS_ADDRESS = 'ws://localhost:8767';
const BIDIRECTIONAL_LISTENER_ID = 'solidworks-bidirectional-sync';
const BIDIRECTIONAL_MOUSE_ID = 'solidworks-bidirectional-mouse';
const MIL_TO_MM = 0.0254;
const MM_TO_MIL = 1 / 0.0254;
const POSITION_SYNC_THROTTLE_MS = 120;
const ECHO_SUPPRESS_MS = 900;

let isExporting = false;
let activeUploadSessionId: string | null = null;

interface ImportCompletionWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}

let importCompletionWaiters: ImportCompletionWaiter[] = [];

const CHUNK_SIZE = 512 * 1024; // 512KB per chunk
const STORAGE_KEY_BIDIRECTIONAL = 'solidworks_bidirectional';

function isBidirectionalEnabled(): boolean {
	return eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_BIDIRECTIONAL) === true;
}
let wsReady = false;
let designatorToPrimitiveId: Map<string, string> = new Map();
let solidworksLabelToDesignator: Map<string, string> = new Map();
let primitiveIdToDesignator: Map<string, string> = new Map();
let syncIdToPrimitiveId: Map<string, string> = new Map();
let primitiveIdToSyncId: Map<string, string> = new Map();
let lastPositionSentAt: Map<string, number> = new Map();
let pendingPositionTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
let suppressDeleteEchoUntil: Map<string, number> = new Map();
let suppressRenameEchoUntil: Map<string, number> = new Map();

function stateSnapshot(): string {
	return `wsReady=${wsReady}, isBidirectional=${isBidirectionalEnabled()}, edaMap=${syncIdToPrimitiveId.size}, swMap=${solidworksLabelToDesignator.size}`;
}

function waitForSolidWorksImportComplete(timeoutMs = 180000): Promise<void> {
	return new Promise((resolve, reject) => {
		const waiter: ImportCompletionWaiter = {
			resolve: () => {
				clearTimeout(waiter.timeoutId);
				resolve();
			},
			reject: (error: Error) => {
				clearTimeout(waiter.timeoutId);
				reject(error);
			},
			timeoutId: setTimeout(() => {
				importCompletionWaiters = importCompletionWaiters.filter(item => item !== waiter);
				reject(new Error('等待 SolidWorks 导入完成超时'));
			}, timeoutMs),
		};
		importCompletionWaiters.push(waiter);
	});
}

function resolveImportCompletionWaiters(): void {
	const waiters = importCompletionWaiters;
	importCompletionWaiters = [];
	for (const waiter of waiters)
		waiter.resolve();
}

function rejectImportCompletionWaiters(error: Error): void {
	const waiters = importCompletionWaiters;
	importCompletionWaiters = [];
	for (const waiter of waiters)
		waiter.reject(error);
}

function registerBidirectionalListeners(): void {
	try {
		if (eda.pcb_Event.isEventListenerAlreadyExist(BIDIRECTIONAL_LISTENER_ID))
			eda.pcb_Event.removeEventListener(BIDIRECTIONAL_LISTENER_ID);
	}
	catch {}
	eda.pcb_Event.addPrimitiveEventListener(BIDIRECTIONAL_LISTENER_ID, 'all', onPcbPrimitiveChange);
	console.log(`[双向] 已注册 PrimitiveEventListener`);

	try {
		if (eda.pcb_Event.isEventListenerAlreadyExist(BIDIRECTIONAL_MOUSE_ID))
			eda.pcb_Event.removeEventListener(BIDIRECTIONAL_MOUSE_ID);
	}
	catch {}
	eda.pcb_Event.addMouseEventListener(BIDIRECTIONAL_MOUSE_ID, 'all', onPcbMouseEvent);
	console.log(`[双向] 已注册 MouseEventListener(all)`);
}

export function activate(status?: 'onStartupFinished', arg?: string): void {
	// 启动时重置双向状态为false，确保每次重启都需要用户手动启用
	eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_BIDIRECTIONAL, false);
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		eda.sys_I18n.text('PCB SolidWorks 导出工具 v', undefined, undefined, extensionConfig.version),
		eda.sys_I18n.text('About'),
	);
}

// ==================== 连接 ====================

async function connectToSolidWorksAsync(): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			const timeoutId = setTimeout(() => {
				if (!wsReady)
					reject(new Error('连接超时'));
			}, 5000);
			eda.sys_WebSocket.register(SOLIDWORKS_WEBSOCKET_ID, DEFAULT_SOLIDWORKS_ADDRESS, handleSolidWorksMessage, () => {
				clearTimeout(timeoutId);
				wsReady = true;
				console.log(`[连接] 连接成功, ${stateSnapshot()}`);
				if (isBidirectionalEnabled()) {
					console.log(`[连接] 恢复SolidWorks端监听`);
					sendToSolidWorks({ type: 'enable_monitor' });
				}
				resolve();
			});
		}
		catch (error) { reject(error); }
	});
}

export function connectSolidWorks(): void {
	if (wsReady) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('已连接到SolidWorks服务器'), ESYS_ToastMessageType.INFO);
		return;
	}
	eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在连接到SolidWorks服务器...'), ESYS_ToastMessageType.INFO);
	try {
		eda.sys_WebSocket.register(SOLIDWORKS_WEBSOCKET_ID, DEFAULT_SOLIDWORKS_ADDRESS, handleSolidWorksMessage, () => {
			wsReady = true;
			console.log(`[连接] 连接成功, ${stateSnapshot()}`);
			if (isBidirectionalEnabled()) {
				console.log(`[连接] 恢复SolidWorks端监听`);
				sendToSolidWorks({ type: 'enable_monitor' });
			}
			eda.sys_Message.showToastMessage(eda.sys_I18n.text('成功连接到SolidWorks服务器!'), ESYS_ToastMessageType.SUCCESS);
		});
	}
	catch (error) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('连接SolidWorks失败: ${1}', undefined, undefined, (error as Error).message), ESYS_ToastMessageType.ERROR);
	}
}

// ==================== 消息处理 ====================

async function handleSolidWorksMessage(event: MessageEvent<any>): Promise<void> {
	wsReady = true;
	try {
		const raw = typeof event === 'string' ? event : (event as any).data || event;
		const message = typeof raw === 'string' ? JSON.parse(raw) : raw;
		console.log(`[收到] type=${message.type}, ${stateSnapshot()}`);
		switch (message.type) {
			case 'pong':
				break;
			case 'connection_confirmed':
				eda.sys_Message.showToastMessage(eda.sys_I18n.text('SolidWorks连接已确认'), ESYS_ToastMessageType.SUCCESS);
				break;
			case 'upload_progress':
				eda.sys_Message.showToastMessage(eda.sys_I18n.text('处理中 ${1}%', undefined, undefined, message.progress), ESYS_ToastMessageType.INFO);
				break;
			case 'upload_started':
				console.log('[上传] 服务端已接受分片上传, sessionId=' + message.sessionId);
				break;
			case 'chunk_received':
				if (activeUploadSessionId === message.sessionId) {
					const pct = Math.round(message.received / message.total * 100);
					console.log('[上传] 分片 ' + message.index + ' 已确认, 进度 ' + pct + '%');
				}
				break;
			case 'upload_complete':
				eda.sys_Message.showToastMessage(eda.sys_I18n.text('文件上传完成，正在导入到SolidWorks...'), ESYS_ToastMessageType.SUCCESS);
				break;
			case 'import_started':
				eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在导入STEP文件到SolidWorks...'), ESYS_ToastMessageType.INFO);
				break;
			case 'import_progress':
				if (activeUploadSessionId === message.sessionId) {
					const sec = Math.round(message.elapsed_ms / 1000);
					console.log('[导入] 进行中, 已耗时 ' + sec + 's');
				}
				break;
			case 'import_complete':
				isExporting = false;
				activeUploadSessionId = null;
				resolveImportCompletionWaiters();
				eda.sys_Message.showToastMessage(eda.sys_I18n.text('PCB导入完成: ${1}', undefined, undefined, message.details || '成功'), ESYS_ToastMessageType.SUCCESS);
				break;
			case 'error':
				isExporting = false;
				activeUploadSessionId = null;
				rejectImportCompletionWaiters(new Error(message.message || 'SolidWorks 返回错误'));
				eda.sys_Message.showToastMessage(eda.sys_I18n.text('SolidWorks错误: ${1}', undefined, undefined, message.message), ESYS_ToastMessageType.ERROR);
				break;
			case 'mapping_result':
				await handleMappingResult(message.mapping);
				break;
			case 'position_update_from_solidworks':
				await handlePositionUpdateFromSolidWorks(message);
				break;
			case 'cross_probe_from_solidworks':
				await handleCrossProbeFromSolidWorks(message);
				break;
			case 'delete_from_solidworks':
				await handleDeleteFromSolidWorks(message);
				break;
			case 'rename_from_solidworks':
				await handleRenameFromSolidWorks(message);
				break;
			case 'document_changed':
				if (isBidirectionalEnabled()) {
					disableBidirectional();
					eda.sys_Message.showToastMessage(eda.sys_I18n.text('SolidWorks文档已切换，双向交互已自动停止，请重新启用'), ESYS_ToastMessageType.WARNING);
				}
				break;
			default:
				console.log(`[收到] 未知消息类型: ${message.type}`);
		}
	}
	catch (error) {
		console.error(`[收到] 消息处理异常:`, error);
	}
}

// ==================== 分片上传工具 ====================

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 8192;
	let binary = '';
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
		binary += String.fromCharCode.apply(null, slice);
	}
	return btoa(binary);
}

async function sendFileChunked(buffer: ArrayBuffer, filename: string): Promise<void> {
	const sessionId = Date.now().toString(36) + Math.random().toString(36).substring(2);
	activeUploadSessionId = sessionId;

	const totalSize = buffer.byteLength;
	const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

	sendToSolidWorks({
		type: 'file_upload_start',
		sessionId,
		filename,
		totalSize,
		totalChunks,
	});

	// Wait a tick for server to be ready
	await new Promise(r => setTimeout(r, 50));

	for (let i = 0; i < totalChunks; i++) {
			if (!wsReady) throw new Error("上��过程中连接断开");
		const start = i * CHUNK_SIZE;
		const end = Math.min(start + CHUNK_SIZE, totalSize);
		const chunk = buffer.slice(start, end);
		const base64Data = arrayBufferToBase64(chunk);

		sendToSolidWorks({
			type: 'file_upload_chunk',
			sessionId,
			index: i,
			data: base64Data,
		});

		// Yield to event loop every 10 chunks to avoid blocking UI
		if (i % 10 === 9) {
			await new Promise(r => setTimeout(r, 0));
		}
	}

	console.log('[上传] 所有分片已发送: ' + totalChunks + ' 片, ' + (totalSize / 1024).toFixed(1) + ' KB');
}

// ==================== 导出 ====================

export async function exportToSolidWorks(): Promise<void> {
	await exportToSolidWorksInternal();
}

async function exportToSolidWorksInternal(): Promise<boolean> {
	if (isExporting) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在导出中，请稍候...'), ESYS_ToastMessageType.INFO);
		return false;
	}
	try {
		isExporting = true;
		disableBidirectional();
		if (!wsReady) {
			eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在连接到SolidWorks服务器...'), ESYS_ToastMessageType.INFO);
			await connectToSolidWorksAsync();
			if (!wsReady)
				throw new Error('无法连接到SolidWorks服务器');
		}
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在获取PCB 3D STEP文件...'), ESYS_ToastMessageType.INFO);
		const pcbFile = await eda.pcb_ManufactureData.get3DFile('pcbModel', 'step', ['Component Model'], 'Parts');
		if (!pcbFile)
			throw new Error('无法获取PCB 3D STEP文件');
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('PCB STEP文件获取成功: ${1} (${2} KB)', undefined, undefined, pcbFile.name, (pcbFile.size / 1024).toFixed(2)), ESYS_ToastMessageType.SUCCESS);

		const fileArrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				if (reader.result instanceof ArrayBuffer)
					resolve(reader.result); else reject(new Error('FileReader返回的不是ArrayBuffer'));
			};
			reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
			reader.readAsArrayBuffer(pcbFile);
		});
		if (fileArrayBuffer.byteLength === 0)
			throw new Error('PCB文件数据为空');

		const filename = pcbFile.name.endsWith('.step') ? pcbFile.name : `${pcbFile.name}.step`;
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在发送文件到SolidWorks: ${1} KB', undefined, undefined, (fileArrayBuffer.byteLength / 1024).toFixed(2)), ESYS_ToastMessageType.INFO);
		await sendFileChunked(fileArrayBuffer, filename);
		return true;
	}
	catch (error) {
		isExporting = false;
		activeUploadSessionId = null;
		rejectImportCompletionWaiters(error instanceof Error ? error : new Error(String(error)));
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('导出失败: ${1}', undefined, undefined, (error as Error).message), ESYS_ToastMessageType.ERROR);
		return false;
	}
}

export async function syncToSolidWorks(): Promise<void> {
	if (isExporting) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在导出中，请稍候...'), ESYS_ToastMessageType.INFO);
		return;
	}

	try {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('开始一键同步到 SolidWorks...'), ESYS_ToastMessageType.INFO);
		const importComplete = waitForSolidWorksImportComplete();
		const exportStarted = await exportToSolidWorksInternal();
		if (!exportStarted) {
			importComplete.catch(() => {});
			return;
		}

		eda.sys_Message.showToastMessage(eda.sys_I18n.text('STEP 已发送，正在等待 SolidWorks 导入完成...'), ESYS_ToastMessageType.INFO);
		await importComplete;
		await new Promise(resolve => setTimeout(resolve, 500));

		eda.sys_Message.showToastMessage(eda.sys_I18n.text('SolidWorks 导入完成，正在启用双向交互...'), ESYS_ToastMessageType.INFO);
		await enableBidirectional();

		if (isBidirectionalEnabled()) {
			eda.sys_Message.showToastMessage(eda.sys_I18n.text('一键同步完成，已进入双向交互模式'), ESYS_ToastMessageType.SUCCESS);
		}
	}
	catch (error) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('一键同步失败: ${1}', undefined, undefined, (error as Error).message), ESYS_ToastMessageType.ERROR);
	}
}

// ==================== 双向交互 ====================

export async function enableBidirectional(): Promise<void> {
	console.log(`[双向] ===== 开始启用 ===== ${stateSnapshot()}`);
	if (false && isBidirectionalEnabled()) {
		console.log(`[双向] 已启用，跳过`);
		return;
	}

	if (!wsReady) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在连接到SolidWorks服务器...'), ESYS_ToastMessageType.INFO);
		try {
			await connectToSolidWorksAsync();
		}
		catch (error) {
			eda.sys_Message.showToastMessage(eda.sys_I18n.text('连接SolidWorks失败: ${1}', undefined, undefined, (error as Error).message), ESYS_ToastMessageType.ERROR);
			return;
		}
	}

	designatorToPrimitiveId.clear();
	primitiveIdToDesignator.clear();
	syncIdToPrimitiveId.clear();
	primitiveIdToSyncId.clear();
	solidworksLabelToDesignator.clear();

	let components: any[] = [];
	try {
		components = await eda.pcb_PrimitiveComponent.getAll();
		console.log(`[双向] 获取到 ${components.length} 个元件`);
	}
	catch (error) {
		console.error('[双向] 获取元件列表失败:', error);
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('获取元件列表失败，无法启用双向交互'), ESYS_ToastMessageType.ERROR);
		return;
	}

	if (components.length === 0) {
		console.log(`[双向] 失败: components.length=0`);
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('未找到任何元件，无法启用双向交互'), ESYS_ToastMessageType.WARNING);
		return;
	}

	for (const comp of components) {
		const designator = comp.getState_Designator();
		const primitiveId = comp.getState_PrimitiveId();
		if (primitiveId) {
			const syncId = primitiveId;
			const displayName = designator || primitiveId;
			syncIdToPrimitiveId.set(syncId, primitiveId);
			primitiveIdToSyncId.set(primitiveId, syncId);
			primitiveIdToDesignator.set(primitiveId, displayName);
		}
		if (designator && primitiveId) {
			designatorToPrimitiveId.set(designator, primitiveId);
		}
	}
	console.log(`[双向] edaMap=${syncIdToPrimitiveId.size}, 明细: [${[...primitiveIdToDesignator.values()].join(', ')}]`);

	if (syncIdToPrimitiveId.size === 0) {
		console.log(`[双向] 失败: 所有元件primitiveId为空`);
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('没有元件有有效的图元ID，无法启用双向交互'), ESYS_ToastMessageType.WARNING);
		return;
	}

	registerBidirectionalListeners();

	const componentData: Array<{ syncId: string; designator: string; x: number; y: number; rotation: number }> = [];
	for (const [syncId, primitiveId] of syncIdToPrimitiveId) {
		try {
			const comp = await eda.pcb_PrimitiveComponent.get(primitiveId);
			if (comp) {
				const designator = comp.getState_Designator() || primitiveId;
				componentData.push({ syncId, designator, x: comp.getState_X() * MIL_TO_MM, y: comp.getState_Y() * MIL_TO_MM, rotation: comp.getState_Rotation() });
			}
		}
		catch (error) {
			console.error(`[双向] 获取元件 ${syncId} 位置失败:`, error);
		}
	}
	console.log(`[双向] componentData=${componentData.length} 条`);

	if (componentData.length === 0) {
		console.log(`[双向] 失败: 无法获取任何元件位置`);
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('无法获取元件位置数据，无法启用双向交互'), ESYS_ToastMessageType.ERROR);
		try {
			eda.pcb_Event.removeEventListener(BIDIRECTIONAL_LISTENER_ID);
			eda.pcb_Event.removeEventListener(BIDIRECTIONAL_MOUSE_ID);
		}
		catch {}
		return;
	}

	// 先标记启用，��发消息
	eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_BIDIRECTIONAL, true);
	console.log(`[双向] isBidirectional=true, 准备发送build_mapping`);

	sendToSolidWorks({ type: 'build_mapping', components: componentData });
	console.log(`[双向] build_mapping 已发送 (${componentData.length} 个元件)`);
	sendToSolidWorks({ type: 'enable_monitor' });
	console.log(`[双向] enable_monitor 已发送`);

	eda.sys_Message.showToastMessage(
		eda.sys_I18n.text('双向交互已启动，点击元件可以双向定位，拖动元件可以同步移动'),
		ESYS_ToastMessageType.SUCCESS,
	);
	console.log(`[双向] ===== 启用完成 ===== ${stateSnapshot()}`);
}

export function disableBidirectional(): void {
	if (!isBidirectionalEnabled())
		return;
	eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_BIDIRECTIONAL, false);
	console.log(`[双向] ===== 停止 =====`);

	try { eda.pcb_Event.removeEventListener(BIDIRECTIONAL_LISTENER_ID); } catch {}
	try { eda.pcb_Event.removeEventListener(BIDIRECTIONAL_MOUSE_ID); } catch {}

	sendToSolidWorks({ type: 'disable_monitor' });

	designatorToPrimitiveId.clear();
	primitiveIdToDesignator.clear();
	syncIdToPrimitiveId.clear();
	primitiveIdToSyncId.clear();
	solidworksLabelToDesignator.clear();
	lastPositionSentAt.clear();
	suppressDeleteEchoUntil.clear();
	suppressRenameEchoUntil.clear();
	for (const timer of pendingPositionTimers.values())
		clearTimeout(timer);
	pendingPositionTimers.clear();

	eda.sys_Message.showToastMessage(eda.sys_I18n.text('双向交互已停止'), ESYS_ToastMessageType.INFO);
}

async function handleMappingResult(mapping: Array<{ syncId?: string; designator: string; solidworksLabel?: string; freecadLabel?: string }>): Promise<void> {
	console.log(`[双向] 收到mapping_result: ${mapping?.length || 0} 条匹配, ${stateSnapshot()}`);
	solidworksLabelToDesignator.clear();
	for (const item of mapping) {
		const solidworksLabel = item.solidworksLabel || item.freecadLabel;
		if (!solidworksLabel)
			continue;
		solidworksLabelToDesignator.set(solidworksLabel, item.syncId || item.designator);
		console.log(`[双向]   ${solidworksLabel} <-> ${item.designator} (${item.syncId || 'no-syncId'})`);
	}

	// 自愈：如果 edaMap 为空但 mapping 有结果，从 EDA API 重建
	if (mapping.length > 0) {
		console.log(`[双向] 开始自愈检查, edaMap=${syncIdToPrimitiveId.size}, isBidirectional=${isBidirectionalEnabled()}`);
		const designators = new Set(mapping.map(m => m.designator));
		const syncIds = new Set(mapping.map(m => m.syncId).filter(Boolean) as string[]);
		try {
			const components = await eda.pcb_PrimitiveComponent.getAll();
			let rebuilt = 0;
			for (const comp of components) {
				const d = comp.getState_Designator();
				const pid = comp.getState_PrimitiveId();
				if (!pid)
					continue;
				if (syncIds.has(pid) || (d && designators.has(d))) {
					const displayName = d || pid;
					syncIdToPrimitiveId.set(pid, pid);
					primitiveIdToSyncId.set(pid, pid);
					primitiveIdToDesignator.set(pid, displayName);
					if (d)
						designatorToPrimitiveId.set(d, pid);
					rebuilt++;
				}
			}
			console.log(`[双向] 重建完成: edaMap=${rebuilt}, ${stateSnapshot()}`);

			// isBidirectional 只由用户操作控制，自愈不触碰
			if (isBidirectionalEnabled()) {
				registerBidirectionalListeners();
				console.log(`[双向] 自愈: 已刷新事件监听器`);
			} else {
				console.log(`[双向] isBidirectional=false，跳过listener恢复`);
			}
		}
		catch (e) { console.error(`[双向] 重建失败:`, e); }
	}

	console.log(`[双向] 映射处理完毕, ${stateSnapshot()}`);
	if (mapping.length === 0)
		eda.sys_Message.showToastMessage(eda.sys_I18n.text("未匹配到任何元件，建议先导出模型再启用双向交互"), ESYS_ToastMessageType.WARNING);
}

// EDA → SolidWorks
function onPcbPrimitiveChange(eventType: string, props: any[]): void {
	if (!isBidirectionalEnabled())
		return;
	for (const prop of props) {
		const syncId = getSyncIdFromEventProp(prop);
		if (!syncId)
			continue;
		const designator = getDesignatorFromSyncId(syncId);
		if (eventType === 'modify')
			requestPositionSyncToSolidWorks(prop, syncId);
		else if (eventType === 'delete') {
			if (isEchoSuppressed(suppressDeleteEchoUntil, syncId))
				continue;
			sendToSolidWorks({ type: 'delete_object', syncId, designator });
		}
	}
}

function onPcbMouseEvent(eventType: string, props: any[]): void {
	if (!isBidirectionalEnabled() || !props || props.length === 0)
		return;

	if (eventType === 'move') {
		for (const prop of props) {
			const syncId = getSyncIdFromEventProp(prop);
			if (syncId)
				requestPositionSyncToSolidWorks(prop, syncId);
		}
		return;
	}

	if (eventType === 'selected') {
		try {
			const syncId = getSyncIdFromEventProp(props[0]);
			if (syncId)
				sendToSolidWorks({ type: 'cross_probe', syncId, designator: getDesignatorFromSyncId(syncId) });
		}
		catch (error) { console.error('[双向] 交叉定位失败:', error); }
	}
}

function getSyncIdFromEventProp(prop: any): string | undefined {
	const primitiveId = prop?.parentComponentPrimitiveId || prop?.primitiveId;
	if (primitiveId) {
		const syncId = primitiveIdToSyncId.get(primitiveId) || primitiveId;
		if (syncIdToPrimitiveId.has(syncId) || primitiveIdToDesignator.has(primitiveId))
			return syncId;
	}

	const designator = prop?.parentComponentDesignator || prop?.designator;
	if (designator)
		return primitiveIdToSyncId.get(designatorToPrimitiveId.get(designator) || '') || designator;

	return undefined;
}

function getDesignatorFromSyncId(syncId: string): string {
	const primitiveId = syncIdToPrimitiveId.get(syncId) || syncId;
	return primitiveIdToDesignator.get(primitiveId) || syncId;
}

function requestPositionSyncToSolidWorks(prop: any, syncId: string): void {
	const primitiveId = syncIdToPrimitiveId.get(syncId)
		|| prop?.parentComponentPrimitiveId
		|| prop?.primitiveId;
	if (!primitiveId)
		return;

	const now = Date.now();
	const lastSentAt = lastPositionSentAt.get(syncId) || 0;
	const sendNow = () => {
		const pendingTimer = pendingPositionTimers.get(syncId);
		if (pendingTimer) {
			clearTimeout(pendingTimer);
			pendingPositionTimers.delete(syncId);
		}
		lastPositionSentAt.set(syncId, Date.now());
		void syncPositionToSolidWorks(syncId, primitiveId);
	};

	if (now - lastSentAt >= POSITION_SYNC_THROTTLE_MS) {
		sendNow();
		return;
	}

	const oldTimer = pendingPositionTimers.get(syncId);
	if (oldTimer)
		clearTimeout(oldTimer);
	pendingPositionTimers.set(syncId, setTimeout(sendNow, POSITION_SYNC_THROTTLE_MS));
}

async function syncPositionToSolidWorks(syncId: string, primitiveId: string): Promise<void> {
	try {
		const targetId = syncIdToPrimitiveId.get(syncId) || primitiveId;
		const comp = await eda.pcb_PrimitiveComponent.get(targetId);
		if (!comp)
			return;

		const currentDesignator = comp.getState_Designator() || targetId;
		const oldDesignator = primitiveIdToDesignator.get(targetId);
		if (oldDesignator !== currentDesignator) {
			if (oldDesignator)
				designatorToPrimitiveId.delete(oldDesignator);
			if (comp.getState_Designator())
				designatorToPrimitiveId.set(currentDesignator, targetId);
			primitiveIdToDesignator.set(targetId, currentDesignator);
			if (!isEchoSuppressed(suppressRenameEchoUntil, syncId))
				sendToSolidWorks({ type: 'rename_designator', syncId, old: oldDesignator, new: currentDesignator });
		}

		const x = comp.getState_X() * MIL_TO_MM;
		const y = comp.getState_Y() * MIL_TO_MM;
		const rotation = comp.getState_Rotation();
		console.log(`[EDA→SW] position_update ${currentDesignator} (${syncId}): x=${x.toFixed(3)}mm, y=${y.toFixed(3)}mm, r=${rotation}`);
		sendToSolidWorks({ type: 'position_update', syncId, designator: currentDesignator, x, y, rotation });
	}
	catch (error) { console.error('[双向] 同步位置失败:', error); }
}

// SolidWorks → EDA
async function handlePositionUpdateFromSolidWorks(message: any): Promise<void> {
	console.log(`[SW→EDA] position_update: syncId=${message.syncId}, designator=${message.designator}, x=${message.x}, y=${message.y}`);
	if (!isBidirectionalEnabled()) {
		console.log(`[SW→EDA] 跳过: isBidirectional=false, ${stateSnapshot()}`);
		return;
	}
	const designator = message.designator;
	const primitiveId = await resolvePrimitiveIdFromSolidWorksMessage(message);
	if (!primitiveId) {
		console.log(`[SW→EDA] 彻底找不到: ${message.syncId || designator}`);
		return;
	}
	try {
		const comp = await eda.pcb_PrimitiveComponent.get(primitiveId);
		if (!comp) return;
		comp.setState_X(message.x * MM_TO_MIL);
		comp.setState_Y(message.y * MM_TO_MIL);
		comp.setState_Rotation(message.rotation);
		await comp.done();
		console.log(`[SW→EDA] 位置更新成功: ${designator || primitiveId}`);
	}
	catch (error) { console.error('[SW→EDA] 位置更新异常:', error); }
}

async function handleCrossProbeFromSolidWorks(message: any): Promise<void> {
	console.log(`[SW→EDA] cross_probe: syncId=${message.syncId}, designator=${message.designator}`);
	if (!isBidirectionalEnabled()) {
		console.log(`[SW→EDA] 跳过: isBidirectional=false, ${stateSnapshot()}`);
		return;
	}
	const designator = message.designator;
	const primitiveId = await resolvePrimitiveIdFromSolidWorksMessage(message);
	if (!primitiveId && !designator) {
		console.log(`[SW→EDA] 跳过: 找不到可定位对象`);
		return;
	}
	console.log(`[SW→EDA] 执行交叉定位: ${designator || primitiveId}`);
	try {
		if (primitiveId)
			await eda.pcb_SelectControl.doSelectPrimitives([primitiveId]);
		else if (designator)
			await eda.pcb_SelectControl.doCrossProbeSelect([designator], undefined, undefined, true, true);
		if (message.x !== undefined && message.y !== undefined)
			await eda.pcb_Document.navigateToCoordinates(message.x * MM_TO_MIL, message.y * MM_TO_MIL);
		console.log(`[SW→EDA] 交叉定位成功: ${designator || primitiveId}`);
	}
	catch (error) { console.error('[SW→EDA] 交叉定位异常:', error); }
}

async function handleDeleteFromSolidWorks(message: any): Promise<void> {
	console.log(`[SW→EDA] delete: designator=${message.designator}`);
	if (!isBidirectionalEnabled()) {
		console.log(`[SW→EDA] 跳过: isBidirectional=false, ${stateSnapshot()}`);
		return;
	}
	const designator = message.designator;
	const primitiveId = await resolvePrimitiveIdFromSolidWorksMessage(message);
	if (!primitiveId) {
		console.log(`[SW→EDA] 跳过: 找不到可删除对象`);
		return;
	}
	try {
		markEchoSuppressed(suppressDeleteEchoUntil, message.syncId || primitiveId);
		await eda.pcb_PrimitiveComponent.delete([primitiveId]);
		if (designator)
			designatorToPrimitiveId.delete(designator);
		primitiveIdToDesignator.delete(primitiveId);
		const syncId = primitiveIdToSyncId.get(primitiveId);
		if (syncId)
			syncIdToPrimitiveId.delete(syncId);
		primitiveIdToSyncId.delete(primitiveId);
		console.log(`[SW→EDA] 删除成功: ${designator || primitiveId}`);
	}
	catch (error) { console.error('[SW→EDA] 删除异常:', error); }
}

async function handleRenameFromSolidWorks(message: any): Promise<void> {
	const oldDesignator = message.oldDesignator || message.old || message.designator;
	const newDesignator = message.newDesignator || message.new;
	console.log(`[SW->EDA] rename: ${oldDesignator} -> ${newDesignator}, syncId=${message.syncId}`);
	if (!isBidirectionalEnabled()) {
		console.log(`[SW->EDA] rename skipped: bidirectional disabled`);
		return;
	}
	if (!newDesignator) {
		console.log(`[SW->EDA] rename skipped: empty newDesignator`);
		return;
	}

	const primitiveId = await resolvePrimitiveIdFromSolidWorksMessage({ syncId: message.syncId, designator: oldDesignator });
	if (!primitiveId) {
		console.log(`[SW->EDA] rename skipped: primitive not found`);
		return;
	}

	try {
		markEchoSuppressed(suppressRenameEchoUntil, message.syncId || primitiveId);
		const comp = await eda.pcb_PrimitiveComponent.get(primitiveId);
		if (!comp)
			return;

		const previousDesignator = comp.getState_Designator() || oldDesignator;
		comp.setState_Designator(newDesignator);
		await comp.done();

		if (previousDesignator)
			designatorToPrimitiveId.delete(previousDesignator);
		designatorToPrimitiveId.set(newDesignator, primitiveId);
		primitiveIdToDesignator.set(primitiveId, newDesignator);
		const syncId = message.syncId || primitiveIdToSyncId.get(primitiveId) || primitiveId;
		syncIdToPrimitiveId.set(syncId, primitiveId);
		primitiveIdToSyncId.set(primitiveId, syncId);
		console.log(`[SW->EDA] rename OK: ${previousDesignator || primitiveId} -> ${newDesignator}`);
	}
	catch (error) { console.error('[SW->EDA] rename exception:', error); }
}

async function resolvePrimitiveIdFromSolidWorksMessage(message: any): Promise<string | undefined> {
	const syncId = message.syncId;
	if (syncId && syncIdToPrimitiveId.has(syncId))
		return syncIdToPrimitiveId.get(syncId);

	const designator = message.designator;
	if (designator && designatorToPrimitiveId.has(designator))
		return designatorToPrimitiveId.get(designator);

	if (!syncId && !designator)
		return undefined;

	try {
		const components = await eda.pcb_PrimitiveComponent.getAll();
		for (const comp of components) {
			const pid = comp.getState_PrimitiveId();
			const d = comp.getState_Designator();
			if (!pid)
				continue;
			if ((syncId && pid === syncId) || (!syncId && designator && d === designator)) {
				const displayName = d || pid;
				syncIdToPrimitiveId.set(pid, pid);
				primitiveIdToSyncId.set(pid, pid);
				primitiveIdToDesignator.set(pid, displayName);
				if (d)
					designatorToPrimitiveId.set(d, pid);
				console.log(`[SW→EDA] 动态查找成功: ${displayName} -> ${pid}`);
				return pid;
			}
		}
	}
	catch (error) { console.error(`[SW→EDA] 动态查找失败:`, error); }

	return undefined;
}

function markEchoSuppressed(store: Map<string, number>, key: string | undefined): void {
	if (!key)
		return;
	store.set(key, Date.now() + ECHO_SUPPRESS_MS);
}

function isEchoSuppressed(store: Map<string, number>, key: string | undefined): boolean {
	if (!key)
		return false;
	const until = store.get(key);
	if (!until)
		return false;
	if (Date.now() <= until)
		return true;
	store.delete(key);
	return false;
}

function sendToSolidWorks(data: Record<string, any>): void {
	try { eda.sys_WebSocket.send(SOLIDWORKS_WEBSOCKET_ID, JSON.stringify(data)); }
	catch (error) { console.error('[发送失败]', error); wsReady = false; }
}

// ==================== 断开连接 ====================

export function disconnectSolidWorks(): void {
	if (isBidirectionalEnabled())
		disableBidirectional();
	if (!wsReady) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('未连接到SolidWorks服务器'), ESYS_ToastMessageType.INFO);
		return;
	}
	try {
		eda.sys_WebSocket.close(SOLIDWORKS_WEBSOCKET_ID, 1000, '用户主动断开连接');
		wsReady = false;
		isExporting = false;
		console.log(`[连接] 已断开`);
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('已断开与SolidWorks的连接'), ESYS_ToastMessageType.INFO);
	}
	catch (error) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('断开连接失败: ${1}', undefined, undefined, (error as Error).message), ESYS_ToastMessageType.ERROR);
	}
}

export function checkSolidWorksConnection(): void {
	console.log(`[检查] ${stateSnapshot()}`);
	eda.sys_Message.showToastMessage(
		eda.sys_I18n.text('SolidWorks连接状态: ${1}', undefined, undefined, wsReady ? eda.sys_I18n.text('已连接') : eda.sys_I18n.text('未连接')),
		wsReady ? ESYS_ToastMessageType.SUCCESS : ESYS_ToastMessageType.WARNING,
	);
}

