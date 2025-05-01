import { onMounted, onUnmounted, watch, type Ref, nextTick } from 'vue'

interface StringAttributeRefConfig {
    attribute: string
    ref: Ref<string | null>
    type?: 'string'
    reflect?: boolean
}

interface BooleanAttributeRefConfig {
    attribute: string
    ref: Ref<boolean>
    type: 'boolean'
    reflect?: boolean
}

interface NumberAttributeRefConfig {
    attribute: string
    ref: Ref<number | null>
    type: 'number'
    reflect?: boolean
}

export type AttributeRefConfig = StringAttributeRefConfig | BooleanAttributeRefConfig | NumberAttributeRefConfig

export interface IUseReflectAttributeOptions {
    /**
     * A list of configurations defining which attributes to observe and their corresponding Refs,
     * and the synchronization direction for each.
     */
    attributes: Array<AttributeRefConfig>

    /**
     * An optional callback function that is called whenever any of the configured attributes
     * change on the target element via direct DOM manipulation or external scripts.
     * Changes initiated by the Ref -> DOM sync will NOT trigger this callback.
     * @param attributeName The name of the attribute that changed.
     * @param oldValue The previous raw string value of the attribute (or null).
     * @param newValue The new raw string value of the attribute (or null).
     * @param interpretedValue The interpreted value (string | null | boolean) based on the attribute type, representing the value that *would* be assigned to the Ref if reflect was true.
     */
    onAttributeChange?: (
        attributeName: string,
        oldValue: string | null,
        newValue: string | null,
        interpretedValue: string | null | boolean
    ) => void

    /**
     * When the value is 'before', the code will be executed directly when onMounted. 
     * When the value is 'after', the code will be executed at the nextTick timing in onMounted.
     */
    tick?: 'before' | 'after'
}

function makeAttributeConfigMap(attributes: Array<AttributeRefConfig>): Map<string, Required<AttributeRefConfig>> {
    const attributeConfigMap = new Map<string, Required<AttributeRefConfig>>()

    attributes.forEach(config => {
        if (config && config.attribute && config.ref) {
            const effectiveConfig: Required<AttributeRefConfig> = {
                reflect: config.reflect ?? true,
                type: config.type ?? 'string',
                ...config,
            } as any

            if (effectiveConfig.type === 'boolean' && !isType(effectiveConfig.ref.value, 'boolean') && !isType(effectiveConfig.ref.value, null) && !isType(effectiveConfig.ref.value, 'undefined')) {
                (effectiveConfig.ref as Ref<any>).value = Boolean(effectiveConfig.ref.value)
            } else if (effectiveConfig.type === 'number' && !isType(effectiveConfig.ref.value, 'boolean') && !isType(effectiveConfig.ref.value, null) && !isType(effectiveConfig.ref.value, 'undefined')) {
                const coercedValue = Number(effectiveConfig.ref.value);
                (effectiveConfig.ref as Ref<any>).value = isNaN(coercedValue) ? null : coercedValue
            }

            attributeConfigMap.set(effectiveConfig.attribute, effectiveConfig)
        } else {
            console.warn('useAttributeObserver: Invalid attribute configuration provided. Missing name or ref.', config)
        }
    })

    return attributeConfigMap
}

function isType(anyTypeValue: any, expectedType: 'string' | 'boolean' | 'number' | 'object' | 'undefined' | null): boolean {
    // Handle null explicitly as typeof null is 'object'
    if (expectedType === null) {
        return anyTypeValue === null
    }
    // Handle undefined explicitly
    if (expectedType === 'undefined') {
        return anyTypeValue === undefined
    }
    // Handle other types using typeof
    return typeof anyTypeValue === expectedType
}


/**
 * A Vue 3 composable function that observes changes to specified attributes
 * on a target HTML element using MutationObserver and synchronizes them with
 * provided Vue Ref objects based on the `reflect` option and `type` for each attribute.
 *
 * - Ref changes will ALWAYS synchronize TO the DOM attribute (Ref -> DOM).
 * - DOM changes will synchronize TO the Ref *ONLY IF* `reflect` is `true`.
 *
 * An `onAttributeChange` callback reports raw DOM changes that did NOT originate from
 * the Ref -> DOM synchronization managed by this composable.
 *
 * @param targetRef A Vue `Ref` that will hold the target HTMLElement to observe.
 * @param options Configuration options, including the list of attribute/ref configurations and the callback.
 * @returns This composable primarily works via side effects (updating Refs or DOM) and callbacks. It doesn't return reactive state itself.
 */
export function useReflectAttribute(
    targetRef: Ref<HTMLElement | null>,
    options: IUseReflectAttributeOptions
): void {

    const { attributes = [], onAttributeChange } = options

    const attributeConfigMap = makeAttributeConfigMap(attributes)
    const attributeFilter: Array<string> = Array.from(attributeConfigMap.keys())

    if (attributeFilter.length === 0) {
        return
    }


    let observer: MutationObserver | null = null

    // Store watcher stop functions for Ref -> DOM sync watchers
    const refToDomSyncStops: Array<Function> = []

    // Flag to indicate that a DOM update is being caused by our Ref -> DOM sync logic.
    // This prevents the MutationObserver from triggering the onAttributeChange callback
    // for changes that we initiated internally. It also helps the DOM->Ref sync logic
    // in the observer avoid updating the Ref if it's already the source of the change.
    let isUpdatingDomFromRef = false

    const mountedCallback = (target: HTMLElement) => {
        attributeConfigMap.forEach(config => {
            const attrName = config.attribute

            // Ref -> DOM Watcher for this attribute
            const stopWatch = watch(config.ref, (newValue: unknown, _) => {
                const currentTargetInWatcher = targetRef.value
                if (!currentTargetInWatcher) return

                if (config.type === 'boolean') {
                    let desiredDomPresence = newValue === true
                    const currentDomPresenceInWatcher = currentTargetInWatcher.hasAttribute(attrName)

                    if (currentDomPresenceInWatcher !== desiredDomPresence) {
                        isUpdatingDomFromRef = true
                        try {
                            if (desiredDomPresence) {
                                currentTargetInWatcher.setAttribute(attrName, '')
                            } else {
                                currentTargetInWatcher.removeAttribute(attrName)
                            }
                        } finally {
                            setTimeout(() => { isUpdatingDomFromRef = false }, 0)
                        }
                    }
                } else {
                    let desiredDomValue = newValue === null || newValue === undefined ? null : String(newValue)
                    const currentDomValueInWatcher = currentTargetInWatcher.getAttribute(attrName)

                    if (currentDomValueInWatcher !== desiredDomValue) {
                        isUpdatingDomFromRef = true
                        try {
                            if (desiredDomValue === null) {
                                currentTargetInWatcher.removeAttribute(attrName)
                            } else {
                                currentTargetInWatcher.setAttribute(attrName, desiredDomValue)
                            }
                        } finally {
                            setTimeout(() => { isUpdatingDomFromRef = false }, 0)
                        }
                    }
                }
            }, {
                immediate: false,
            })

            refToDomSyncStops.push(stopWatch)

            // --- Initial Sync on Mount ---
            // Always push Ref value to DOM initially.
            // If reflect is true, then pull DOM value back into Ref afterward.
            const initialRefValue = config.ref.value
            const currentDomRawValue = target.getAttribute(attrName)

            /**
             * @example
             * ```
             * const selected = ref(true)
             * <div selected></div>
             * 
             * const selected = ref(false)
             * <div></div>
             * ```
             */
            if (config.type === 'boolean') {
                const initialRefPresence = initialRefValue === true
                if (target.hasAttribute(attrName) !== initialRefPresence) {
                    if (initialRefPresence) {
                        target.setAttribute(attrName, '')
                    } else {
                        target.removeAttribute(attrName)
                    }
                }
            }
            /**
             * @example
             * ```
             * const text = ref(null)
             * <div></div>
             * 
             * const text = ref("")
             * <div text></div>
             * 
             * const text = ref("VALUE")
             * <div text="VALUE"></div>
             * ```
             */
            else {
                const desiredDomValueInitially = initialRefValue === null || initialRefValue === undefined ? null : String(initialRefValue)
                if (currentDomRawValue !== desiredDomValueInitially) {
                    if (desiredDomValueInitially === null) {
                        target.removeAttribute(attrName)
                    } else {
                        target.setAttribute(attrName, desiredDomValueInitially)
                    }
                }
            }

            if (config.reflect === true) {
                // Get the raw value from the DOM *after* any potential initial Ref->DOM sync just occurred
                const currentDomRawValueAfterInitialSync = target.getAttribute(attrName)
                let interpretedValueFromDom: string | null | boolean | number | null

                if (config.type === 'boolean') {
                    interpretedValueFromDom = target.hasAttribute(attrName)
                } else if (config.type === 'number') {
                    const numValue = Number(currentDomRawValueAfterInitialSync)
                    interpretedValueFromDom = currentDomRawValueAfterInitialSync === null ? null : (isNaN(numValue) ? null : numValue)
                } else {
                    interpretedValueFromDom = currentDomRawValueAfterInitialSync ?? null
                }

                if (config.ref.value !== interpretedValueFromDom) {
                    (config.ref as Ref<any>).value = interpretedValueFromDom
                }
            }
        })

        // --- Setup DOM -> Ref Sync (for reflect: true attributes) via MutationObserver ---
        // This observer catches changes NOT caused by our Ref->DOM watcher (because of the isUpdatingDomFromRef flag)
        // or changes from external sources (other JS, dev tools).
        observer = new MutationObserver((records) => {
            const currentTarget = targetRef.value
            if (!currentTarget) return

            for (const record of records) {
                // We only care about attribute changes on the target element itself
                if (record.type === 'attributes' && record.target === currentTarget) {
                    const attributeName = record.attributeName as string
                    const config = attributeConfigMap.get(attributeName)

                    if (config) {
                        const oldValue = record.oldValue
                        const newValue = currentTarget.getAttribute(attributeName)

                        let interpretedNewValue: string | null | boolean
                        if (config.type === 'boolean') {
                            interpretedNewValue = currentTarget.hasAttribute(attributeName)
                        } else {
                            interpretedNewValue = newValue ?? null
                        }

                        if (!isUpdatingDomFromRef && onAttributeChange && (oldValue !== newValue)) {
                            onAttributeChange(attributeName, oldValue, newValue, interpretedNewValue)
                        }

                        // If reflect is true for this attribute, update the Ref
                        if (config.reflect === true) {
                            if (config.ref.value !== interpretedNewValue) {
                                (config.ref as Ref<any>).value = interpretedNewValue
                            }
                        }
                    }
                }
            }
        })

        observer.observe(target, {
            attributes: true,
            attributeFilter: attributeFilter,
            attributeOldValue: true,
        })
    }

    onMounted(() => {
        if (typeof window === 'undefined') {
            return
        }

        const target = targetRef.value
        const tick = options.tick ?? 'after'

        if (!target) {
            console.warn('useAttributeObserver: Target element ref is null on mount. Cannot start observer or watchers.')
            return
        }

        if (tick === 'after') {
            nextTick(() => {
                mountedCallback(target)
            })
        } else {
            mountedCallback(target)
        }

    })

    onUnmounted(() => {
        observer?.disconnect()
        observer = null

        refToDomSyncStops.forEach(stop => stop())
        refToDomSyncStops.length = 0
    })

    return
}
