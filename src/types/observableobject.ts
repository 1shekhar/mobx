import {
    $mobx,
    Atom,
    ComputedValue,
    IAtom,
    IComputedValueOptions,
    IEnhancer,
    IInterceptable,
    IListenable,
    Lambda,
    ObservableValue,
    addHiddenProp,
    assertPropertyConfigurable,
    createInstanceofPredicate,
    deepEnhancer,
    endBatch,
    getNextId,
    hasInterceptors,
    hasListeners,
    interceptChange,
    isObject,
    isPlainObject,
    isPropertyConfigurable,
    isSpyEnabled,
    notifyListeners,
    referenceEnhancer,
    registerInterceptor,
    registerListener,
    spyReportEnd,
    spyReportStart,
    startBatch,
    stringifyKey,
    globalState,
    ADD
} from "../internal"
import { UPDATE } from "./observablearray"
import { die } from "../errors"

// TODO: kill
export interface IObservableObject {
    "observable-object": IObservableObject
}

export type IObjectDidChange<T = any> =
    | {
          name: PropertyKey
          object: T
          type: "add"
          newValue: any
      }
    | {
          name: PropertyKey
          object: T
          type: "update"
          oldValue: any
          newValue: any
      }
    | {
          name: PropertyKey
          object: T
          type: "remove"
          oldValue: any
      }

export type IObjectWillChange<T = any> =
    | {
          object: T
          type: "update" | "add"
          name: PropertyKey
          newValue: any
      }
    | {
          object: T
          type: "remove"
          name: PropertyKey
      }

const REMOVE = "remove"

export class ObservableObjectAdministration
    implements IInterceptable<IObjectWillChange>, IListenable {
    keysAtom: IAtom
    changeListeners
    interceptors
    proxy: any
    private pendingKeys: undefined | Map<PropertyKey, ObservableValue<boolean>>

    constructor(
        public target: any,
        public values = new Map<PropertyKey, ObservableValue<any> | ComputedValue<any>>(),
        public name: string,
        public defaultEnhancer: IEnhancer<any>
    ) {
        this.keysAtom = new Atom(name + ".keys")
    }

    read(key: PropertyKey) {
        return this.values.get(key)!.get()
    }

    write(key: PropertyKey, newValue) {
        const instance = this.target
        const observable = this.values.get(key)
        if (observable instanceof ComputedValue) {
            observable.set(newValue)
            return
        }

        // intercept
        if (hasInterceptors(this)) {
            const change = interceptChange<IObjectWillChange>(this, {
                type: UPDATE,
                object: this.proxy || instance,
                name: key,
                newValue
            })
            if (!change) return
            newValue = (change as any).newValue
        }
        newValue = (observable as any).prepareNewValue(newValue)

        // notify spy & observers
        if (newValue !== globalState.UNCHANGED) {
            const notify = hasListeners(this)
            const notifySpy = __DEV__ && isSpyEnabled()
            const change =
                notify || notifySpy
                    ? {
                          type: UPDATE,
                          object: this.proxy || instance,
                          oldValue: (observable as any).value,
                          name: key,
                          newValue
                      }
                    : null

            if (__DEV__ && notifySpy) spyReportStart({ ...change, name: this.name, key })
            ;(observable as ObservableValue<any>).setNewValue(newValue)
            if (notify) notifyListeners(this, change)
            if (__DEV__ && notifySpy) spyReportEnd()
        }
    }

    has(key: PropertyKey) {
        const map = this.pendingKeys || (this.pendingKeys = new Map())
        let entry = map.get(key)
        if (entry) return entry.get()
        else {
            const exists = !!this.values.get(key)
            // Possible optimization: Don't have a separate map for non existing keys,
            // but store them in the values map instead, using a special symbol to denote "not existing"
            entry = new ObservableValue(
                exists,
                referenceEnhancer,
                `${this.name}.${stringifyKey(key)}?`,
                false
            )
            map.set(key, entry)
            return entry.get() // read to subscribe
        }
    }

    addObservableProp(
        propName: PropertyKey,
        newValue,
        enhancer: IEnhancer<any> = this.defaultEnhancer
    ) {
        const { target } = this
        assertPropertyConfigurable(target, propName)

        if (hasInterceptors(this)) {
            const change = interceptChange<IObjectWillChange>(this, {
                object: this.proxy || target,
                name: propName,
                type: ADD,
                newValue
            })
            if (!change) return
            newValue = (change as any).newValue
        }
        const observable = new ObservableValue(
            newValue,
            enhancer,
            `${this.name}.${stringifyKey(propName)}`,
            false
        )
        this.values.set(propName, observable)
        newValue = (observable as any).value // observableValue might have changed it

        Object.defineProperty(target, propName, generateObservablePropConfig(propName))
        this.notifyPropertyAddition(propName, newValue)
    }

    addComputedProp(
        propertyOwner: any, // where is the property declared?
        propName: PropertyKey,
        options: IComputedValueOptions<any>
    ) {
        const { target } = this
        options.name = options.name || `${this.name}.${stringifyKey(propName)}`
        options.context = this.proxy || target
        this.values.set(propName, new ComputedValue(options))
        if (propertyOwner === target || isPropertyConfigurable(propertyOwner, propName))
            // TODO: extract util?
            Object.defineProperty(propertyOwner, propName, generateComputedPropConfig(propName))
    }

    remove(key: PropertyKey) {
        if (!this.values.has(key)) return
        const { target } = this
        if (hasInterceptors(this)) {
            const change = interceptChange<IObjectWillChange>(this, {
                object: this.proxy || target,
                name: key,
                type: REMOVE
            })
            if (!change) return
        }
        try {
            startBatch()
            const notify = hasListeners(this)
            const notifySpy = __DEV__ && isSpyEnabled()
            const oldObservable = this.values.get(key)
            const oldValue = oldObservable && oldObservable.get()
            oldObservable && oldObservable.set(undefined)
            // notify key and keyset listeners
            this.keysAtom.reportChanged()
            this.values.delete(key)
            if (this.pendingKeys) {
                const entry = this.pendingKeys.get(key)
                if (entry) entry.set(false)
            }
            // delete the prop
            delete this.target[key]
            const change =
                notify || notifySpy
                    ? {
                          type: REMOVE,
                          object: this.proxy || target,
                          oldValue: oldValue,
                          name: key
                      }
                    : null
            if (__DEV__ && notifySpy) spyReportStart({ ...change, name: this.name, key })
            if (notify) notifyListeners(this, change)
            if (__DEV__ && notifySpy) spyReportEnd()
        } finally {
            endBatch()
        }
    }

    // TODO: is this still needed?
    illegalAccess(owner, propName) {
        /**
         * This happens if a property is accessed through the prototype chain, but the property was
         * declared directly as own property on the prototype.
         *
         * E.g.:
         * class A {
         * }
         * extendObservable(A.prototype, { x: 1 })
         *
         * classB extens A {
         * }
         * console.log(new B().x)
         *
         * It is unclear whether the property should be considered 'static' or inherited.
         * Either use `console.log(A.x)`
         * or: decorate(A, { x: observable })
         *
         * When using decorate, the property will always be redeclared as own property on the actual instance
         */
        __DEV__ &&
            console.warn(
                `Property '${propName}' of '${owner}' was accessed through the prototype chain. Use 'decorate' instead to declare the prop or access it statically through it's owner`
            )
    }

    /**
     * Observes this object. Triggers for the events 'add', 'update' and 'delete'.
     * See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/observe
     * for callback details
     */
    observe(callback: (changes: IObjectDidChange) => void, fireImmediately?: boolean): Lambda {
        if (__DEV__ && fireImmediately === true)
            die("`observe` doesn't support the fire immediately property for observable objects.")
        return registerListener(this, callback)
    }

    intercept(handler): Lambda {
        return registerInterceptor(this, handler)
    }

    notifyPropertyAddition(key: PropertyKey, newValue) {
        const notify = hasListeners(this)
        const notifySpy = __DEV__ && isSpyEnabled()
        const change =
            notify || notifySpy
                ? {
                      type: ADD,
                      object: this.proxy || this.target,
                      name: key,
                      newValue
                  }
                : null

        if (__DEV__ && notifySpy) spyReportStart({ ...change, name: this.name, key })
        if (notify) notifyListeners(this, change)
        if (__DEV__ && notifySpy) spyReportEnd()
        if (this.pendingKeys) {
            const entry = this.pendingKeys.get(key)
            if (entry) entry.set(true)
        }
        this.keysAtom.reportChanged()
    }

    getKeys(): PropertyKey[] {
        this.keysAtom.reportObserved()
        // return Reflect.ownKeys(this.values) as any
        const res: PropertyKey[] = []
        for (const [key, value] of this.values) if (value instanceof ObservableValue) res.push(key)
        return res
    }
}

export interface IIsObservableObject {
    $mobx: ObservableObjectAdministration
}

export function asObservableObject(
    target: any,
    name: PropertyKey = "",
    defaultEnhancer: IEnhancer<any> = deepEnhancer
): ObservableObjectAdministration {
    if (Object.prototype.hasOwnProperty.call(target, $mobx)) return target[$mobx]

    if (__DEV__ && !Object.isExtensible(target))
        die("Cannot make the designated object observable; it is not extensible")
    if (!isPlainObject(target))
        name = (target.constructor.name || "ObservableObject") + "@" + getNextId()
    if (!name) name = "ObservableObject@" + getNextId()

    const adm = new ObservableObjectAdministration(
        target,
        new Map(),
        stringifyKey(name),
        defaultEnhancer
    )
    addHiddenProp(target, $mobx, adm)
    return adm
}

const observablePropertyConfigs = Object.create(null)
const computedPropertyConfigs = Object.create(null)

export function generateObservablePropConfig(propName) {
    return (
        observablePropertyConfigs[propName] ||
        (observablePropertyConfigs[propName] = {
            configurable: true,
            enumerable: true,
            get() {
                return this[$mobx].read(propName)
            },
            set(v) {
                this[$mobx].write(propName, v)
            }
        })
    )
}

function getAdministrationForComputedPropOwner(owner: any): ObservableObjectAdministration {
    // TODO: what again does this function?
    const adm = owner[$mobx]
    if (!adm) {
        return owner[$mobx]
    }
    return adm
}

export function generateComputedPropConfig(propName) {
    return (
        computedPropertyConfigs[propName] ||
        (computedPropertyConfigs[propName] = {
            configurable: true,
            enumerable: false,
            get() {
                return getAdministrationForComputedPropOwner(this).read(propName)
            },
            set(v) {
                getAdministrationForComputedPropOwner(this).write(propName, v)
            }
        })
    )
}

// TODO: extract constant for "ObservableObject ?
const isObservableObjectAdministration = createInstanceofPredicate(
    "ObservableObjectAdministration",
    ObservableObjectAdministration
)

export function isObservableObject(thing: any): thing is IObservableObject {
    if (isObject(thing)) {
        return isObservableObjectAdministration((thing as any)[$mobx])
    }
    return false
}
