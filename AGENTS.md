# iPeiTu 开发约定

本项目采用 [SteinsHead/agents-md](https://github.com/SteinsHead/agents-md/blob/master/AGENTS.md) 的协作原则（2026-11-05 已阅读），界面采用 [unslop](https://github.com/heydamir/unslop) 的设计原则。以下是本项目执行约定。

- v0.1 范围：导入本地图片、持久化图库、按名称检索、预览、插入 Windows WPS 文字当前光标。表格扫描、批量自动配图、云图库与 AI 生成不在本版范围。
- 用户已授权后续开发范围和步骤见 `docs/V02-PLAN.md`：v0.2 排版、分类检索、收藏最近；随后替换、导入整理、压缩、启动、团队云图库和表格占位配图。v0.1 的历史范围不限制这些已批准的新步骤。
- 先调查实际接口，再作最小完整实现。外部输入和文件边界需要校验；不要吞掉错误或用模拟成功掩盖真实失败。
- 素材、图库、绝对用户路径与生成的测试文档不提交到 Git。测试使用自行生成的临时素材。
- 每个开发步骤从最新 main 创建 `codex/` 分支，提交 PR；主协调者审查代码与验收证据，检查通过后合并。开发者不得自行跳过验收。
- 同一工作目录内，不并行切换分支或提交。分配到不同模块的子任务只修改约定文件，由协调者提交与合并。
- 针对数据持久化、文件输入、检索和 WPS 文档操作运行有价值的测试。模拟 WPS 测试与实机验收分别记录，不能互相替代。
- 中文 UI、中文开发文档。界面以素材为主体，4px 间距节奏、灰白中性色、单一深青强调色、明确焦点状态，无装饰渐变或表情图标。
- Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
- 长任务进度与真实阻碍记录于 `docs/PLAN.md`；每个 PR 说明具体行为变化、验证结果与尚未验证的范围。

unslop 由 Damir Sokolovsky（[@heydamir](https://x.com/heydamir)）创作，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。本项目设计规则参考其方法，来源：https://github.com/heydamir/unslop。

