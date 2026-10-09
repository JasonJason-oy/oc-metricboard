/**
 * Direct element factory (mirrors oh-my-opencode-slim's `element()` helper).
 *
 * The opencode v2.0.26 Node loader cannot resolve the automatic-JSX entry of
 * `@opentui/solid` from plugin dist, so no JSX may remain in the sources:
 * trees are built by hand with the same call shapes OMO uses —
 * `createElement` + `setProp` + `insert` from the `@opentui/solid` package
 * root.
 *
 * Semantics that MUST stay identical to the old JSX emit:
 * - props are applied, children are inserted, then an optional `ref` callback
 *   runs (JSX `spread` ran children -> ref -> props; running the ref AFTER the
 *   props lets the imperative registerSync pass win at mount — on every mount
 *   state the prop and the sync compute the same values, except where the sync
 *   is the one that knows the truth, e.g. collapse state / hidden model rows).
 * - children are handed to `insert` with ONE array call, matching the JSX
 *   runtime's single-array `insertExpression`. Inserting string siblings
 *   one-by-one would wipe the previously inserted text node.
 * - children must be pre-evaluated values (no accessor functions): this
 *   runtime's tree is non-reactive by design; dynamic values flow through the
 *   components' registerSync -> requestRender path instead.
 */
import { createElement, insert, setProp } from "@opentui/solid"
import type { BaseRenderable } from "@opentui/core"

export function element<T extends BaseRenderable = BaseRenderable>(
    tag: string,
    props: Record<string, unknown> = {},
    children: unknown[] = [],
): T {
    const node = createElement(tag)
    let ref: ((node: BaseRenderable) => void) | undefined
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined) continue
        if (key === "ref") {
            ref = value as typeof ref
            continue
        }
        setProp(node, key, value)
    }
    if (children.length > 0) insert(node, children)
    ref?.(node)
    return node as T
}
