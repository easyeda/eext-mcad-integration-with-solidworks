# SolidWorks 机电协同

中文 | [English](README_en.md)

通过 WebSocket 实现 PCB 3D 模型在嘉立创EDA 与 Solidworks 之间的实时协同。支持模型导出、双向位置同步、交叉定位、删除同步。

## 功能特性
| 功能   | 说明 |
|--------|------|
| 3D 模型导出 | 将 PCB 的 STEP 模型分片传输到 Solidworks|
| 双向位置同步   | EDA 拖动元件 → Solidworks 跟着动，反之亦然   |
| 交叉定位 | 点击一边的元件，另一边自动聚焦|
| 删除同步 | EDA 删除元件，Solidworks 同步移除|

## 环境要求
| 项目   | 要求 |
|--------|------|
| Solidworks | 版本 ≥ 2016 SP5|
| 嘉立创EDA   | 版本 ≥ 3.0   |
| 网络 | 本机可用（localhost）|

## 使用说明

### 安装扩展到嘉立创 EDA

1. 打开嘉立创 EDA 专业版。
2. 进入 `高级 -> 扩展管理器`。
3. 点击 `导入`，选择 `build/dist/mcad-solidworks-sync_v1.0.0.eext`。
4. 在已安装扩展中启用 `SolidWorks机电协同`。
5. 打开该扩展的 `外部交互` 权限，否则 WebSocket 无法连接本机桥接服务。
![图 0](images/README_20260623_215526.jpg)

#### 菜单入口

安装后，在 PCB 编辑器顶部菜单中会出现 `SolidWorks机电协同`：

- `导出3D到SolidWorks`
- `启用双向交互`
- `停止双向交互`
- `连接SolidWorks`
- `断开SolidWorks`
- `检查SolidWorks连接`

### 安装Solidworks插件“嘉立创Ican工具箱”
1. 进入嘉立创Ican工具箱官网下载安装包：https://ican.jlc.com/
![官网页面](images/官网界面.png)
2. 安装包是一个压缩文件，解压出来，里面有安装教程PDF，按文档教程安装即可。
![安装教程](images/安装教程.png)
3. 安装插件插件后，打开Solidworks，新建零件，会看到嘉立创Ican工具箱工具栏。点击机械社区下拉菜单、开启与Sw进行协调设计按钮。
![开启机电协同](images/开启机电协同.png)
4. 开启后，Solidworks右手边任务栏会出现EDA图标，点击会显示界面。
![机电协同界面位置](images/机电协同界面位置.png)
5. 开启后，会自动启动服务，这时就可以从嘉立创EDA扩展中点击一键同步到Solidworks，就能把PCB模型导入Solidworks开始协同了。
 ![EDA扩展菜单栏](images/EDA扩展菜单栏.png)

## 使用注意事项
1. 导入Sw后，需手动将元件全部浮动，否则位置同步功能会失效。
 ![浮动](images/浮动子装配体.png)
2. 点击高级，可以设置文件保存位置，同步规则等。
![高级设置](images/高级设置.png)
3. 大文件（元件多、3D 模型复杂）导入可能需要数分钟。导入期间Solidworks 界面会无响应，这是正常现象。


