#!/usr/bin/env node
/**
 * 深目录夹具生成器（确定性，无随机）。
 *
 * 为什么需要它：`benchmarks/eval/fixture` 只有 14 个源文件、最深 2 层。
 * `decideFilesense` 给出的预算是 maxEntries 180~300 —— 对 14 个文件永远不会关闸，
 * 而且一次 `ls -R` 就能把整个结构塞进上下文。在那种夹具上，filesense 与直接跑命令
 * **在构造上就没有区别**，无论跑出什么通过率，都是夹具的结论而不是能力的结论。
 *
 * 本夹具针对性地制造两个条件：
 *
 * 1. **预算会被打满**：feature-sliced 结构下，从 `src` 起 depth 2 的条目数
 *    远超 250，三闸截断真的会发生。
 * 2. **定位本身是难的**：同名文件（`format.ts` / `Button.tsx` / `useToggle.ts` …）
 *    刻意散布在多个 feature 下，只有一个是任务目标。没有语义导航就只能靠猜——
 *    这正是「命令拿物理事实、拿不到语义事实」那条主张的可测形式。
 *
 * 生成物进 .gitignore：仓库里只留生成器与手写锚点文件，避免几百个文件的噪音 diff。
 *
 * 用法：node benchmarks/eval/fixture-deep/generate.mjs
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'src');

/**
 * 已提交的手写锚点——tasks-deep.json 真正要动的文件。
 * 清理生成树时必须绕开它们，否则重跑生成器会把埋好的 bug 一起删掉。
 */
const ANCHORED_FEATURES = new Set(['checkout', 'cart', 'shipping']);

/** 特征域名。数量决定广度——是预算闸能否关上的主要杠杆。 */
const FEATURES = [
  'checkout',
  'catalog',
  'cart',
  'search',
  'account',
  'orders',
  'wishlist',
  'reviews',
  'shipping',
  'payments',
  'promotions',
  'inventory',
  'analytics',
  'notifications',
  'support',
  'onboarding',
  'settings',
  'billing',
  'returns',
  'loyalty',
  'recommendations',
  'compare',
  'subscriptions',
  'gifting',
];

/** 实体域名（比 feature 薄一层，制造深度不齐的真实感）。 */
const ENTITIES = [
  'user',
  'product',
  'order',
  'address',
  'coupon',
  'invoice',
  'session',
  'category',
  'review',
  'shipment',
  'refund',
  'subscription',
];

const pascal = (s) => s[0].toUpperCase() + s.slice(1);

function write(relPath, content) {
  const abs = join(SRC, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

// ─── 噪音层：每个 feature 一套同构文件 ────────────────────────────────────────
// 同构是刻意的：`format.ts`、`Button.tsx`、`useToggle.ts` 在 24 个 feature 下各有一份，
// 仅凭文件名无法判断哪个是目标。

// 先清理上一轮的生成物：不清的话，改动 FEATURES / ENTITIES 后重跑会留下孤儿文件，
// 条目数与截断行为随之漂移——而这两个数正是这个夹具存在的理由。
for (const feature of FEATURES) {
  if (ANCHORED_FEATURES.has(feature)) {
    // 锚点 feature 只清生成的子目录，保留 lib/ 下已提交的文件
    for (const sub of ['api', 'model', 'hooks', 'ui']) {
      rmSync(join(SRC, 'features', feature, sub), { recursive: true, force: true });
    }
    continue;
  }
  rmSync(join(SRC, 'features', feature), { recursive: true, force: true });
}
for (const entity of ENTITIES) {
  rmSync(join(SRC, 'entities', entity), { recursive: true, force: true });
}

for (const feature of FEATURES) {
  const F = pascal(feature);

  write(
    `features/${feature}/api/${feature}Api.ts`,
    `import type { ${F}Dto } from '../model/types.js';\n\n` +
      `export async function fetch${F}(id: string): Promise<${F}Dto> {\n` +
      `  return { id, label: '${feature}' };\n}\n`,
  );

  write(
    `features/${feature}/model/types.ts`,
    `export interface ${F}Dto {\n  id: string;\n  label: string;\n}\n`,
  );

  write(
    `features/${feature}/model/selectors.ts`,
    `import type { ${F}Dto } from './types.js';\n\n` +
      `export const select${F}Label = (dto: ${F}Dto): string => dto.label;\n`,
  );

  // 同名文件之一：每个 feature 都有一个 format.ts
  write(
    `features/${feature}/lib/format.ts`,
    `export function format(value: number): string {\n` +
      `  return \`${feature}:\${value.toFixed(2)}\`;\n}\n`,
  );

  // 同名文件之二：每个 feature 都有一个 useToggle.ts
  write(
    `features/${feature}/hooks/useToggle.ts`,
    `import { useState } from 'react';\n\n` +
      `export function useToggle(initial = false): [boolean, () => void] {\n` +
      `  const [on, setOn] = useState(initial);\n` +
      `  return [on, () => setOn((prev) => !prev)];\n}\n`,
  );

  // 同名文件之三：每个 feature 都有一个 Button.tsx
  write(
    `features/${feature}/ui/Button.tsx`,
    `export interface ButtonProps {\n  label: string;\n  onClick: () => void;\n}\n\n` +
      `export const Button = ({ label, onClick }: ButtonProps) => (\n` +
      `  <button type="button" onClick={onClick}>{label}</button>\n);\n`,
  );

  write(
    `features/${feature}/ui/${F}List.tsx`,
    `import type { ${F}Dto } from '../model/types.js';\n\n` +
      `export const ${F}List = ({ items }: { items: ${F}Dto[] }) => (\n` +
      `  <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>\n);\n`,
  );

  write(
    `features/${feature}/index.ts`,
    `export * from './ui/${F}List.js';\nexport * from './model/types.js';\n`,
  );
}

for (const entity of ENTITIES) {
  const E = pascal(entity);
  write(
    `entities/${entity}/model/${entity}.ts`,
    `export interface ${E} {\n  id: string;\n  createdAt: string;\n}\n`,
  );
  write(
    `entities/${entity}/model/guards.ts`,
    `import type { ${E} } from './${entity}.js';\n\n` +
      `export const is${E} = (value: unknown): value is ${E} =>\n` +
      `  typeof value === 'object' && value !== null && 'id' in value;\n`,
  );
  write(
    `entities/${entity}/ui/${E}Badge.tsx`,
    `export const ${E}Badge = ({ id }: { id: string }) => <span>{id}</span>;\n`,
  );
}

const featureCount = FEATURES.length;
const entityCount = ENTITIES.length;
console.log(
  `generated: ${featureCount} features × 8 files + ${entityCount} entities × 3 files ` +
    `= ${featureCount * 8 + entityCount * 3} noise files under ${SRC}`,
);
