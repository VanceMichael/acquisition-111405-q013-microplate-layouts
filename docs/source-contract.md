# 来源与既有应用契约

## 新来源

GET /plate 返回plateId、layout、runs。layout有version、rows、columns、orientation(0/180)、wells按A1格式给sampleId和role(sample/control/blank)。run含runId、layoutVersion、channel{kind,wavelength,gain,unit}、order(row-major/serpentine)、readings数组{ordinal,value,quality}，ordinal为从0起仪器坐标顺序。orientation在仪器坐标到物理孔位时作用；蛇形奇数行反向，再按orientation映射。相同孔不同run是不同观测。quality=overflow的value为null，不是0。输出plateId、runId、well、sampleId、role、channel、value、quality、layoutStatus。 run可带receipt URL，POST该URL表示原始测次已耐久接收；确认后仪器可令run URL返回410，布局接口仍可在之后补齐。布局href定位该次run所需版本，响应404表示尚未发布；按既有归档重新运行时必须从耐久原文继续关联。输出关联修订而非覆盖已有历史；尚无布局的测次输出layoutStatus=unresolved并令complete=false。

本地来源只实现以上明确子集，不要求补全同类公开标准。未声明的字段与语法不得自动解释成有效业务事实。样本中的所有人员、账户、样本、设备与文件内容均为合成资料，无生产访问凭据。

## 接收端实现行为（source 模式）

耐久顺序：对每个 run 先 GET 原文并随响应证据落 `raw/`，成功落库后才 POST `receipt` 确认；确认与各次响应都作为证据留存。若 run 已在归档中（按完整 URL 与方法匹配的 2xx 证据），重新运行直接复用耐久原文，不再向仪器请求 run，也不重复 POST 确认——即使仪器随后对 run 返回 410。plate 清单与已发布的布局同样优先复用归档副本；只有缺失或仍处于 404 的布局会再次尝试领取。

布局关联：只接受与 run 的 `layoutVersion` 完全一致的布局。布局 404 记 `layout-pending`，版本不一致记 `layout-version-conflict`，两种情况下每条读数都输出 `layoutStatus: "unresolved"` 且不带 well/sampleId/role，`complete=false`；任何同名板、其他版本或其他来源的布局都不得用于填空。布局发布后重新采集，resolved 结果以新修订追加，早先的 unresolved 修订原样保留。

坐标解释：`ordinal` 先按 `order` 展开（`row-major` 逐行；`serpentine` 的奇数行反向），再按 `orientation` 做 0/180 度整体映射得到物理孔位 A1 形式；布局孔数、orientation、order、ordinal 与 quality 均做结构校验，畸形输入只产生带位置的 issue，不产生关联记录。

读数保留：`channel`（吸光度/荧光的 kind、wavelength、gain、unit）与读数 `value`、`quality` 原样保留，`overflow` 的 value 保持 null；仪器附加标记（如重测 `flags`）原样透传，不解释未声明字段。溢出落在 blank/control 等 QC 孔时保留为带 overflow 标记的观测记录；溢出落在 sample 孔意味着该样本本次测量失效，不发布关联记录，转为 `sample-well-overflow` issue（含完整读数与孔位）以便复核。

记录身份：resolved 记录 id 为 `plateId/runId/well/<孔位>`，unresolved 记录 id 为 `plateId/runId/ordinal/<序号>`；同一 id 的内容变化在归档中形成新修订，历史只追加不改写。

## 接收接口

既有调用是 `collect({baseUrl, archive, mode})`。`mode` 默认为 `legacy`；新增来源使用 `source`。返回 `{records, complete, issues, evidenceCount}`：`records` 为本次业务结果，`complete` 表示本次领取及解释是否有未决缺口，`issues` 为带来源位置的可复核问题，`evidenceCount` 为实际接收的原文数。新结果可增加字段，示例不是封闭 schema。

每个落库记录的 `id` 必须非空且稳定，由业务身份决定；业务所需的多身份关系不能都压缩进 `id`。`archive.commit` 接受 `records`、`exchanges` 与 `issues`；原文在 `raw/` 以 SHA-256 寻址，索引引用原文与记录修订。既有归档索引 schema=1 可以扩展，但旧摘要记录必须仍可读取。

应用不得伪造原文，也不能把摘要模式当成新来源成功。HTTP 相对链接基于来源 origin 解析，不能访问其他站点。错误状态、缺数据和空的有效结果应区分。来源解释未决时 `complete=false`，已收的安全独立部分可以保留。

## 可运行资料

`fixtures/scenarios.json` 提供来源响应及预期业务片段；`expected`/`forbidden` 只供回归断言，采集代码不得读取该文件。来源用真实 HTTP 发送数据，二进制夹具由 `$hex` 或 `$octets` 编码，接收方不会看到这些包装键。`/__requests` 是本地测试用请求审计接口，不是资料源。

连续相同 method/path 响应可按数组次序变化，最后一次响应保持；`after` 表达来源步骤先后，`once` 为单次凭证。POST 搜索会按来源能力拒绝不支持的条件。接收端不需要实现来源服务，也不得删改来源限制来通过测试。

上述契约和题面决定功能范围。公开回归提供正常与有冲突/缺口的样例，并未穷举所有组合；应补充与实际设计相符的边界验证。运行与演示不连接新闻站点或其他线上服务。
