# 人物身份解析（阶段 B）

Sense Now 在现有字幕、ASR、OCR、抽帧和时间轴之外，增加了一层可选的人物身份解析。关闭时，索引和查询与以前相同。解析失败时，索引降为 `degraded` 并继续保存原来的字幕和 ASR 文本。

范围是**这一条视频的全时间轴**。不跨视频共享人脸或声纹。

## 现有链路里复用了什么

- 本地文件与 B 站索引、字幕适配器、utterance 时间轴、证据编号。
- 可选的 pyannote 说话人分离仍由原来的 `diarization` 开关控制。本层只读取已经写出的 `speakerClusterId`，不替换 ASR、OCR 或声纹模型。
- 旧的 `identityBinding`（脸和声音的绑定状态机）保持原样。`characterIdentity` 是另一份结果，写在 `summary/character-identity.json`。

没有现成的人物库、口型模型和身份审核界面。结果界面是 `video_index` 工具返回的文本和 `meta`，不是一块新的网页。

## 对象

| 对象 | 含义 |
| --- | --- |
| Person | 人物。编号不随姓名改变。默认显示「未知人物N」 |
| Speaker | 说话人。默认显示「未知说话人N」。可以是画面内、离屏、电话、旁白或未知 |
| VisualTrack | 一段画面轨迹，先属于自己的 Person |
| NameEntity | 从字幕、ASR 或 OCR 里抽出的姓名。被称呼不等于说话人 |
| IdentityCandidate | `speaker_of_person`、`visual_track_of_person`、`name_of_person`、`addresses_person`、`mentions_person`、`possibly_same_person` |
| Evidence | 带来源、时间、是否独立、规则强度。相似度不是概率 |
| IdentityEvent | 创建、修订、确认、否定、合并、拆分 |

状态是 `Unknown → Candidate → Supported → Verified`。Verified 必须带 `system_verified` 或 `user_confirmed`。冲突可以降回去。人工确认带锁，下一次自动解析不会把它盖掉。

## 规则

- 同一时刻有脸又有声音，不因此把声音归给这个人。
- 电话或「你现在在哪里」这类线索只标记 `possible_phone_conversation`。离屏说话人来源记为 `remote`。
- 只有单人嘴型对齐，才把该说话人设为 `Supported` 的 `speaker_of_person`，来源 `on_screen`。
- 「小明，你在哪里」生成 `addresses_person`。说话人仍是未知说话人。
- 「这位是小明」且该时段只有一条画面轨迹，姓名记到这条轨迹的人物上，状态 `Supported`。
- 清晰、非压缩的声纹匹配加上姓名介绍，只确认**这条说话人到该人物的关系**。人物本身是 Verified，不会把其他只有弱关联的说话人一起标成已确认。
- 压缩、重叠、过短的声音只留候选。台词可以显示「可能关联」，但 `verification` 保持空。
- 同一说话人在同一时段只有一条生效归属。人工锁定优先于系统确认。被取代的旧关系保留证据，并标成 overridden。
- 人工决定写在 `summary/character-identity-decisions.json`。重建、缓存刷新和分块索引都会按稳定 id 回放。对不上的操作进入待审核，不静默套到别人身上。解析失败时保留上一份决定和身份视图。
- 分块里的本地说话人编号会加上 chunkId。没有跨块说话人映射时，相同的 `SPEAKER_00` 不会被当成同一个人。
- 同一句文本若 ASR 和 OCR 时间接近，第二份证据 `independent: false`，不重复加分。
- 两个都够强的姓名同时落在同一个人身上，标冲突，不选边。
- 原始 utterance 文本不改。查询时只在前面加解析出的称呼。

只有关系本身是 Verified，台词才显示为「小明：……」。候选或受支持显示「未知说话人N（可能关联：小明，Candidate）」。

`visualTracks` 和 `voiceMatches` 由调用方传入。本层不产生声纹、分轨或口型结果。整片 `index` 与长视频 / URL / B 站分块在索引结束后走同一个解析器。

## 人工操作

`video_index` 动作：

- `identity_resolve` / `identity_list` / `identity_detail`
- `identity_confirm` / `identity_deny` / `identity_rename`
- `identity_link` / `identity_unlink` / `identity_merge` / `identity_split` / `identity_undo`

索引时打开：`capabilities.characterIdentity = "on"`。可以同时传 `visualTracks`、`identityObservations`、`voiceMatches`、`sceneHints`。这些都是已有分析结果，不会重新跑 ASR。

详情里的证据带 `timestamp_start`，对应视频时间点。

## 回溯与缓存

再次解析使用已保存的 utterance、`extras` 和决定日志，不重新解码。查询在写入缓存之前把 `characterIdentity` 装进结果，命中和未命中使用同一份。缓存键带上身份修订号，人工修改后的下一次查询不会返回旧称呼。

## 资源

这一阶段没有新模型。400 句合成台词的规则解析在本机测试里小于 1 秒，不占额外显存。真实 pyannote、OCR、ASR 的耗时仍属于原来的开关，本次没有重新测量 GPU。

## 阶段 C 还没做

数据结构留了 `scope: "video"`、`possibly_same_person`，以及未计算的关系名：`same_as`、`different_from`、`speaks_as`、`mentions`、`addresses`、`appears_with`、`possibly_related`。

还没有跨视频人物库、外观重识别、对话角色图、全局冲突求解。同名候选只记 `possibly_same_person`，不自动合并。

## 测试

`npm test`：322 项通过，0 失败。身份相关测试覆盖链接级确认、人工锁定优先、否认、重建保留决定、失败不覆盖、缓存命中与未命中合同一致、分块说话人不按本地编号合并，以及工具缺参。声纹和画面轨迹仍是调用方传入的结果，不是本层跑出来的模型输出。

尚未用真实成片验证：口型模型、pyannote 聚类、真实 B 站拉流后的身份、多人同时说话的分离错误率。插件目录里没有可索引的样片，本轮没有跑真实音视频。
