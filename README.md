# SolidWorks 机电协同 - 嘉立创 EDA 专业版扩展

这是嘉立创 EDA 专业版侧的 SolidWorks 联动扩展，基于 EasyEDA 官方 FreeCAD 联动扩展迁移而来。

扩展负责：

- 从嘉立创 EDA 导出 PCB 3D STEP 文件
- 通过 WebSocket 将 STEP 分片发送到本机 SolidWorks 桥接服务
- 监听 EDA 侧元件移动、选中、删除和位号变化
- 接收 SolidWorks 桥接服务返回的位置同步、交叉定位和删除同步消息

> 注意：本扩展只包含嘉立创 EDA 端。SolidWorks 端还需要单独实现或运行桥接服务，默认监听地址为 `ws://localhost:8767`。

## 使用说明

### 安装扩展到嘉立创 EDA

1. 打开嘉立创 EDA 专业版。
2. 进入 `高级 -> 扩展管理器`。
3. 点击 `导入`，选择 `build/dist/mcad-solidworks-sync_v1.0.0.eext`。
4. 在已安装扩展中启用 `SolidWorks机电协同`。
5. 打开该扩展的 `外部交互` 权限，否则 WebSocket 无法连接本机桥接服务。

### 菜单入口

安装后，在 PCB 编辑器顶部菜单中会出现 `SolidWorks机电协同`：

- `导出3D到SolidWorks`
- `启用双向交互`
- `停止双向交互`
- `连接SolidWorks`
- `断开SolidWorks`
- `检查SolidWorks连接`

### 安装嘉立创ICAN工具箱

提示：你需要安装SolidWorks2016及以上版本才可以使用ICAN工具箱。

1. 下载嘉立创ICAN工具箱：[https://ican.jlc.com](https://ican.jlc.com)
2. 解压后根据教程安装ICAN工具箱。
3. 打开SolidWorks，找到ICAN工具箱，然后启用EDA交互通讯。

### 通信约定

EDA 扩展作为 WebSocket 客户端连接：

```text
ws://localhost:8767
```

EDA -> SolidWorks 桥接服务：

- `file_upload_start`
- `file_upload_chunk`
- `build_mapping`
- `enable_monitor`
- `disable_monitor`
- `position_update`
- `cross_probe`
- `delete_object`
- `rename_designator`

SolidWorks 桥接服务 -> EDA：

- `connection_confirmed`
- `upload_started`
- `chunk_received`
- `upload_complete`
- `import_started`
- `import_progress`
- `import_complete`
- `mapping_result`
- `position_update_from_solidworks`
- `cross_probe_from_solidworks`
- `delete_from_solidworks`
- `document_changed`
- `error`

`mapping_result` 推荐返回：

```json
{
	"type": "mapping_result",
	"mapping": [
		{
			"designator": "R1",
			"solidworksLabel": "R1"
		}
	]
}
```


## 构建

```powershell
npm install
npm run build
```

生成的 `.eext` 位于：

```text
build/dist/eext-mcad-integration-with-solidworks_v1.0.0.eext
```
