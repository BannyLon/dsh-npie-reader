/**
 * dsh-npie-reader host plugin entry.
 *
 * 函数式插件：Cordis 用 `apply(ctx, config)` 挂载，服务在 apply 内部注册。
 * 不再 `export default <Service 类>`——类式入口要求继承宿主的 Service 基类，
 * 而外部 link 插件的 Host 半区在解析链上拿不到宿主内部包（见 typert-lite.js）。
 * `inject` 必须是本模块的命名导出，Cordis 才会在调用 apply 前等到这些服务。
 */
import { RssService } from './service.js';

export const name = 'dsh-npie-reader';
export const inject = RssService.inject;

/**
 * Mount the `rss` service for the lifetime of this plugin's fiber.
 * @param ctx - the owning Cordis context.
 * @param config - the plugin row's config.
 * @returns the disposer that unregisters the service.
 */
export function apply(ctx, config = {}) {
  const service = new RssService(ctx, config ?? {});
  return ctx.reflect.provide('rss', service);
}

export { RssService };
