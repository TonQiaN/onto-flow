# Action 会话自带 bash，平台不再预处理输入

每个运行的组合挂上游 shell 链（`dsh-tool-bash` + `dsh-bash-sandbox` + `dsh-subprocess-local` +
`dsh-shell-env`）与文件沙箱（`dsh-fs-sandbox` 换掉 `dsh-fs-local`，`dsh-sandbox-policy` +
`dsh-sandbox-local`，`dsh-user-approval` 固定 `policy: "never"`）。`bash` 与 `read`/`write` 同级，
是对**所有** Action 可见的基础工具；bash 与 write/edit 共用同一份 `workspace-write` 策略，
文件写入被圈在运行工作区加系统临时目录，但围栏强度分两档：bash 的 argv 被 Seatbelt
（`sandbox-exec`）内核围栏包住，runner 不可用则 fail-closed 拒绝执行；write/edit 走
`dsh-fs-sandbox` 的进程内路径检查——上游明言是策略围栏而非内核边界。**read 与网络不受限**，
这是上游沙箱词汇的边界，也与工作区目录「只定义协作范围与文件所有权，不是安全边界」
的既有立场一致。

在此能力上**删除平台 PDF 预处理子系统**，不留兼容层（先例 [ADR-0005](0005-folders-not-tags.md)）：
`src/server/pdf-input.ts`、`object_types.file_preprocessor` 列、`PortValue.preprocessed`、
对象类型编辑器的预处理选项与运行对话框的相关提示全部移除。文件输入原样物化为
`inputs/<节点id>/<文件名>`，格式转换（抽文本、栅格化、逐页 `read_image` 核对、裁剪放大）
是 Action 会话里模型用 bash 自己的工作，工作流作者在 prompt/rule 里指导——简历案例
「简历评分·解析」的 rule 是范本。[ADR-0008](0008-artifacts-not-values.md) 中「绑在输入节点上
的对象类型另有一项运行时实职」一句随之废止：对象类型回到纯粹的产物契约类型。

理由：预处理是平台代劳，与「一切实质工作发生在 Action 里」的立场冲突，而且平台永远
猜不全模型需要的形态——实测里视觉模型自发用 Python/PIL 裁剪放大局部再看，这是任何
预生成产物给不了的。真实运行也证明代劳没有必要：文本模型用 `pdftotext` 自理文本 PDF，
视觉模型自己 `pdftoppm` 栅格化后逐页 `read_image`。代价：预处理时代的硬门槛（20 页上限、
文本层 16 MiB、派生合计 128 MiB、PDF 签名前置校验）随之消失，守门只剩上传 32 MiB、
每节点步数与墙钟上限——一份畸形或超大的输入现在烧的是节点的步数预算，而不是在运行
开始前被拒；扫描件能否读出来取决于解析 Action 是否被指派了视觉路由，平台不再兜底。
