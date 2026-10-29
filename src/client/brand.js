/**
 * 插件的中英名称与 slogan —— 界面上所有「这是谁」的地方都读这一份。
 *
 * ★ 为什么单独一个文件：同一句品牌文案原来散在五个 JSX 里（侧栏入口、三个
 *   欢迎页、设置页头部与「关于」），改名时漏掉任何一处，用户就会在同一屏里
 *   同时看到新旧两个名字。这里只放**面向用户**的名字；包名 `dsh-npie-reader`、
 *   存储路径、agent 工具名仍是技术标识，**不跟着改**（改了等于迁移数据）。
 *
 * ★ 名称写法是用户 2026-10-29 定的：中文名 + ` | ` + 英文名。竖线两侧有空格，
 *   和仓库/包名的连字符写法不是一回事，别顺手「规范化」掉。
 */
export const BRAND_ZH = '澄境';
export const BRAND_EN = 'Limina';

/** 界面上写出来的完整中英名。 */
export const BRAND_TITLE = `${BRAND_ZH} | ${BRAND_EN}`;

/** 中文 slogan：主标语，出现在欢迎页与「关于」。 */
export const SLOGAN_ZH = '阅人际，留寸心。';

/** 英文 slogan：跟着中文 slogan 走，字号更小、行距更松，是副标不是第二条口号。 */
export const SLOGAN_EN = 'Glean the World, Guard the Heart.';
