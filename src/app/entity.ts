import * as PIXI from "pixi.js"

import * as util from "./util"
import * as booyah from "./booyah"

export interface IEventListener {
  emitter: PIXI.utils.EventEmitter
  event: string
  cb: () => any
}

export interface Transition {
  name: string
  params: any
}

export type TransitionResolvable =
  | Transition
  | ((name: string, params: any, context: any) => Transition)

export type EntityConfig = {
  container: PIXI.Container
  [k: string]: any
}

export interface FrameInfo {
  playTime: number
  timeSinceStart: number
  timeSinceLastFrame: number
  timeScale: number
  gameState: booyah.GameState
}

export function processEntityConfig(
  entityConfig: any,
  alteredConfig: any
): any {
  if (!alteredConfig) return entityConfig
  if (typeof alteredConfig == "function") return alteredConfig(entityConfig)
  return alteredConfig
}

export function extendConfig(config: any): (entityConfig: any) => {} {
  return (entityConfig) => ({
    ...entityConfig,
    ...config,
  })
}

type EntityResolvable = Entity | ((...params: any[]) => Entity)

/**
 In Booyah, the game is structured as a tree of entities. This is the base class for all entities.

 An entity has the following lifecycle:
 1. It is instantiated using the contructor.
 Only parameters specific to the entity should be passed here.
 The entity should not make any changes to the environment here, it should wait for setup().
 2. setup() is called just once, with a configuration.
 This is when the entity should add dispaly objects  to the scene, or subscribe to events.
 The typical entityConfig contains { app, preloader, narrator, jukebox, container }
 3. update() is called one or more times, with options.
 It could also never be called, in case the entity is torn down directly.
 If the entity wishes to be terminated, it should set this.requestedTransition to a truthy value.
 Typical options include { playTime, timeSinceStart, timeSinceLastFrame, timeScale, gameState }
 For more complicated transitions, it can return an object like { name: "", params: {} }
 4. teardown() is called just once.
 The entity should remove any changes it made, such as adding display objects to the scene, or subscribing to events.

 The base class will check that this lifecyle is respected, and will log errors to signal any problems.

 In the case that, subclasses do not need to override these methods, but override the underscore versions of them: _setup(), _update(), etc.
 This ensures that the base class behavior of will be called automatically.
 */
export abstract class Entity extends PIXI.utils.EventEmitter {
  public isSetup = false
  public eventListeners: IEventListener[] = []
  public requestedTransition: any
  public entityConfig: EntityConfig
  public lastFrameInfo: FrameInfo

  public setup(frameInfo: FrameInfo, entityConfig: EntityConfig): void {
    if (this.isSetup) {
      console.error("setup() called twice", this)
      console.trace()
    }

    this.entityConfig = entityConfig
    this.lastFrameInfo = frameInfo
    this.isSetup = true
    this.requestedTransition = null

    this._setup(frameInfo, entityConfig)
  }

  public update(frameInfo: FrameInfo): void {
    if (!this.isSetup) {
      console.error("update() called before setup()", this)
      console.trace()
    }

    this.lastFrameInfo = frameInfo
    this._update(frameInfo)
  }

  public teardown(frameInfo: FrameInfo): void {
    if (!this.isSetup) {
      console.error("teardown() called before setup()", this)
      console.trace()
    }

    this.lastFrameInfo = frameInfo
    this._teardown(frameInfo)

    this._off() // Remove all event listeners

    this.entityConfig = null
    this.isSetup = false
  }

  public onSignal(frameInfo: FrameInfo, signal: string, data?: any): void {
    if (!this.entityConfig) {
      console.error("onSignal() called before setup()", this)
    }

    this.lastFrameInfo = frameInfo
    this._onSignal(frameInfo, signal, data)
  }

  protected _on(
    emitter: PIXI.utils.EventEmitter,
    event: string,
    cb: (...args: any) => void
  ): void {
    this.eventListeners.push({ emitter, event, cb })
    emitter.on(event, cb, this)
  }

  // if @cb is null, will remove all event listeners for the given emitter and event
  protected _off(
    emitter?: PIXI.utils.EventEmitter,
    event?: string,
    cb?: (...args: any) => void
  ): void {
    let toRemove: IEventListener[] = []

    if (!cb) {
      if (!event) {
        if (!emitter) {
          toRemove = this.eventListeners
        } else {
          toRemove = this.eventListeners.filter((listener) => {
            return listener.emitter === emitter
          })
        }
      } else {
        toRemove = this.eventListeners.filter((listener) => {
          return listener.event === event
        })
      }
    } else {
      toRemove = this.eventListeners.filter((listener) => {
        return listener.cb === cb
      })
    }

    for (const listener of toRemove)
      listener.emitter.off(listener.event, listener.cb, this)

    this.eventListeners = this.eventListeners.filter((listener) => {
      return !toRemove.includes(listener)
    })
  }

  public _setup(frameInfo: FrameInfo, entityConfig: EntityConfig) {}
  public _update(frameInfo: FrameInfo) {}
  public _teardown(frameInfo: FrameInfo) {}
  public _onSignal(frameInfo: FrameInfo, signal: string, data?: any) {}
}

/** Empty class just to indicate an entity that does nothing and never requests a transition  */
export class NullEntity extends Entity {}

/** An entity that returns the requested transition immediately  */
export class TransitoryEntity extends Entity {
  constructor(public transition = true) {
    super()
  }

  _setup() {
    this.requestedTransition = this.transition
  }
}

export interface ParallelEntityOptions {
  autoTransition?: boolean
}

/**
 Allows a bunch of entities to execute in parallel.
 Updates child entities until they ask for a transition, at which point they are torn down.
 If autoTransition=true, requests a transition when all child entities have completed.
 */
export class ParallelEntity extends Entity {
  public entities: Entity[] = []
  public entityConfigs: EntityConfig[] = []
  public entityIsActive: boolean[] = []
  public autoTransition: boolean = false
  /**
   @entities can be subclasses of entity.Entity or an object like { entity:, entityConfig: }
   @options:
   * autoTransition: Should the entity request a transition when all the child entities are done?  (defaults to false)
   */
  constructor(entities: any[] = [], options: ParallelEntityOptions = {}) {
    super()

    util.setupOptions(this, options, {
      autoTransition: false,
    })

    for (const currentEntity of entities) {
      if (currentEntity instanceof Entity) {
        this.addEntity(currentEntity)
      } else {
        this.addEntity(currentEntity.entity, currentEntity.entityConfig)
      }
    }
  }

  setup(frameInfo: FrameInfo, entityConfig: any) {
    super.setup(frameInfo, entityConfig)

    for (let i = 0; i < this.entities.length; i++) {
      const entity = this.entities[i]
      if (!entity.isSetup) {
        const entityConfig = processEntityConfig(
          this.entityConfig,
          this.entityConfigs[i]
        )
        entity.setup(frameInfo, entityConfig)
      }

      this.entityIsActive[i] = true
    }
  }

  update(frameInfo: FrameInfo) {
    super.update(frameInfo)

    for (let i = 0; i < this.entities.length; i++) {
      if (this.entityIsActive[i]) {
        const entity = this.entities[i]

        entity.update(frameInfo)

        if (entity.requestedTransition) {
          entity.teardown(frameInfo)

          this.entityIsActive[i] = false
        }
      }
    }

    if (this.autoTransition && !this.entityIsActive.some((e) => !!e))
      this.requestedTransition = true
  }

  teardown(frameInfo: FrameInfo) {
    for (let i = 0; i < this.entities.length; i++) {
      if (this.entityIsActive[i]) {
        this.entities[i].teardown(frameInfo)
        this.entityIsActive[i] = false
      }
    }

    super.teardown(frameInfo)
  }

  onSignal(frameInfo: FrameInfo, signal: string, data?: any) {
    super.onSignal(frameInfo, signal, data)

    for (let i = 0; i < this.entities.length; i++) {
      if (this.entityIsActive[i])
        this.entities[i].onSignal(frameInfo, signal, data)
    }
  }

  // If entityConfig is provided, it will overload the entityConfig provided to this entity by setup()
  addEntity(entity: Entity, entityConfig: any = null) {
    this.entities.push(entity)
    this.entityConfigs.push(entityConfig)
    this.entityIsActive.push(true)

    // If we have already been setup, setup this new entity
    if (this.isSetup && !entity.isSetup) {
      const newConfig = processEntityConfig(this.entityConfig, entityConfig)
      entity.setup(this.lastFrameInfo, newConfig)
    }
  }

  removeEntity(entity: Entity): void {
    const index = this.entities.indexOf(entity)
    if (index === -1) throw new Error("Cannot find entity to remove")

    if (entity.isSetup) {
      entity.teardown(this.lastFrameInfo)
    }

    this.entities.splice(index, 1)
    this.entityConfigs.splice(index, 1)
    this.entityIsActive.splice(index, 1)
  }

  removeAllEntities(): void {
    for (const entity of this.entities) {
      if (entity.isSetup) {
        entity.teardown(this.lastFrameInfo)
      }

      this.entities = []
      this.entityConfigs = []
      this.entityIsActive = []
    }
  }
}

export interface EntitySequenceOptions {
  loop?: boolean
}

/**
  Runs one child entity after another. 
  When done, requestes the last transition demanded.
  Optionally can loop back to the first entity.
*/
export class EntitySequence extends Entity implements EntitySequenceOptions {
  public loop: boolean
  public currentEntityIndex = 0
  public currentEntity: Entity = null
  public lastRequestedTransition: any

  constructor(
    public entities: EntityResolvable[],
    options: EntitySequenceOptions = {}
  ) {
    super()
    this.loop = !!options.loop
  }

  // Does not setup entity
  addEntity(entity: Entity) {
    if (this.requestedTransition) return

    this.entities.push(entity)
  }

  skip() {
    if (this.requestedTransition) return

    this._advance({ name: "skip" })
  }

  setup(frameInfo: FrameInfo, entityConfig: any) {
    super.setup(frameInfo, entityConfig)

    this.currentEntityIndex = 0
    this.currentEntity = null

    this._activateEntity()
  }

  update(frameInfo: FrameInfo) {
    super.update(frameInfo)

    if (this.lastRequestedTransition) return

    if (this.currentEntityIndex >= this.entities.length) return

    this.currentEntity.update(frameInfo)

    const transition = this.currentEntity.requestedTransition
    if (transition) this._advance(transition)
  }

  teardown(frameInfo: FrameInfo) {
    this._deactivateEntity()

    super.teardown(frameInfo)
  }

  onSignal(frameInfo: FrameInfo, signal: string, data?: any) {
    if (this.requestedTransition) return

    super.onSignal(frameInfo, signal, data)

    this.currentEntity.onSignal(frameInfo, signal, data)

    if (signal === "reset") this.restart()
  }

  restart() {
    this._deactivateEntity()

    this.currentEntityIndex = 0
    this.requestedTransition = false

    this._activateEntity()
  }

  _activateEntity() {
    const entityDescriptor = this.entities[this.currentEntityIndex]
    if (typeof entityDescriptor === "function") {
      this.currentEntity = entityDescriptor(this)
    } else {
      this.currentEntity = entityDescriptor
    }

    this.currentEntity.setup(this.lastFrameInfo, this.entityConfig)
  }

  _deactivateEntity() {
    if (this.currentEntity && this.currentEntity.isSetup)
      this.currentEntity.teardown(this.lastFrameInfo)
  }

  _advance(transition: any) {
    if (this.currentEntityIndex < this.entities.length - 1) {
      this._deactivateEntity()
      this.currentEntityIndex = this.currentEntityIndex + 1
      this._activateEntity()
    } else if (this.loop) {
      this._deactivateEntity()
      this.currentEntityIndex = 0
      this._activateEntity()
    } else {
      this._deactivateEntity()
      this.requestedTransition = transition
    }
  }
}

/** 
  Represents a state machine, where each state has a name, and is represented by an entity.
  Only one state is active at a time. 
  The state machine has one starting state, but can have multiple ending states.
  When the machine reaches an ending state, it requests a transition with a name equal to the name of the ending state.
  By default, the state machine begins at the state called "start", and stops at "end".

  The transitions are not provided directly by the states (entities) by rather by a transition table provided in the constructor.
  A transition is defined as either a name (string) or { name, params }. 
  To use have a transition table within a transition table, use the function makeTransitionTable()
*/
export class StateMachine extends Entity {
  public startingStateParams: any
  public startingState: any
  public startingProgress: any
  public visitedStates: any
  public progress: any
  public state: Entity
  public stateName: string
  public endingStates: any
  public stateParams: {}

  constructor(
    public states: { [n: string]: EntityResolvable },
    public transitions: { [k: string]: TransitionResolvable },
    options: any = {}
  ) {
    super()

    util.setupOptions(this, options, {
      startingState: "start",
      endingStates: ["end"],
      startingStateParams: {},
      startingProgress: {},
    })
  }

  setup(frameInfo: FrameInfo, entityConfig: EntityConfig) {
    super.setup(frameInfo, entityConfig)

    this.visitedStates = []
    this.progress = util.cloneData(this.startingProgress)

    const startingState =
      typeof this.startingState === "function"
        ? this.startingState()
        : this.startingState
    const startingStateParams =
      typeof this.startingStateParams === "function"
        ? this.startingStateParams()
        : this.startingStateParams
    this._changeState(startingState, startingStateParams)
  }

  update(frameInfo: FrameInfo) {
    super.update(frameInfo)

    if (!this.state) return

    this.state.update(frameInfo)

    const requestedTransition = this.state.requestedTransition
    if (requestedTransition) {
      // Unpack requested transition
      let requestedTransitionName, requestedTransitionParams
      if (typeof requestedTransition === "object") {
        requestedTransitionName = requestedTransition.name
        requestedTransitionParams = requestedTransition.params
      } else {
        requestedTransitionName = requestedTransition
      }

      let nextStateDescriptor
      // The transition could directly be the name of another state
      if (
        typeof requestedTransitionName === "string" &&
        requestedTransitionName in this.states &&
        !(this.stateName in this.transitions)
      ) {
        nextStateDescriptor = requestedTransition
      } else if (!(this.stateName in this.transitions)) {
        throw new Error(`Cannot find transition for state '${this.stateName}'`)
      } else {
        const transitionDescriptor = this.transitions[this.stateName]
        if (typeof transitionDescriptor === "function") {
          nextStateDescriptor = transitionDescriptor(
            requestedTransitionName,
            requestedTransitionParams,
            this
          )
        } else if (typeof transitionDescriptor === "string") {
          nextStateDescriptor = transitionDescriptor
        } else {
          throw new Error(
            `Cannot decode transition descriptor '${JSON.stringify(
              transitionDescriptor
            )}'`
          )
        }
      }

      // Unpack the next state
      let nextStateName, nextStateParams
      if (
        typeof nextStateDescriptor === "object" &&
        typeof nextStateDescriptor.name === "string"
      ) {
        nextStateName = nextStateDescriptor.name
        nextStateParams = nextStateDescriptor.params
      } else if (typeof nextStateDescriptor === "string") {
        nextStateName = nextStateDescriptor
        nextStateParams = requestedTransition.params // By default, pass through the params in the requested transition
      } else {
        throw new Error(
          `Cannot decode state descriptor '${JSON.stringify(
            nextStateDescriptor
          )}'`
        )
      }

      this._changeState(nextStateName, nextStateParams)
    }
  }

  teardown(frameInfo: FrameInfo) {
    if (this.state) {
      this.state.teardown(frameInfo)
      this.state = null
      this.stateName = null
    }

    super.teardown(frameInfo)
  }

  onSignal(frameInfo: FrameInfo, signal: string, data?: any) {
    super.onSignal(frameInfo, signal, data)

    if (this.state) this.state.onSignal(frameInfo, signal, data)
  }

  _changeState(nextStateName: string, nextStateParams: any) {
    // If reached an ending state, stop here. Teardown can happen later
    if (this.endingStates.includes(nextStateName)) {
      this.requestedTransition = nextStateName
      this.visitedStates.push(nextStateName)
      return
    }

    if (this.state) {
      this.state.teardown(this.lastFrameInfo)
    }

    if (nextStateName in this.states) {
      const nextStateDescriptor = this.states[nextStateName]
      if (typeof nextStateDescriptor === "function") {
        this.state = nextStateDescriptor(nextStateParams, this)
      } else {
        this.state = nextStateDescriptor
      }

      this.state.setup(this.lastFrameInfo, this.entityConfig)
    } else {
      throw new Error(`Cannot find state '${nextStateName}'`)
    }

    const previousStateName = this.stateName
    const previousStateParams = this.stateParams
    this.stateName = nextStateName
    this.stateParams = nextStateParams

    this.visitedStates.push(nextStateName)

    this.emit(
      "stateChange",
      nextStateName,
      nextStateParams,
      previousStateName,
      previousStateParams
    )
  }
}

/** 
  Creates a transition table for use with StateMachine.
  Example: 
    const transitions = {
      start: entity.makeTransitionTable({ 
        win: "end",
        lose: "start",
      }),
    };
    `
*/
export function makeTransitionTable(table: {
  [key: string]:
    | string
    | ((
        requestedTransitionName: string,
        requestedTransitionParams: any,
        previousStateName: string,
        previousStateParams: any
      ) => string)
}) {
  const f = function (
    requestedTransitionName: string,
    requestedTransitionParams: any,
    previousStateName: string,
    previousStateParams: any
  ) {
    if (requestedTransitionName in table) {
      const transitionDescriptor = table[requestedTransitionName]
      if (typeof transitionDescriptor === "function") {
        return transitionDescriptor(
          requestedTransitionName,
          requestedTransitionParams,
          previousStateName,
          previousStateParams
        )
      } else {
        return transitionDescriptor
      }
    } else {
      throw new Error(`Cannot find state ${requestedTransitionName}`)
    }
  }
  f.table = table // For debugging purposes

  return f
}

/**
  An entity that gets its behavior from functions provided inline in the constructor.
  Useful for small entities that don't require their own class definition.
  Additionally, a function called requestTransition(options, entity), called after update(), can set the requested transition 

  Example usage:
    new FunctionalEntity({
      setup: (entityConfig) => console.log("setup", entityConfig),
      teardown: () => console.log("teardown"),
    });
*/
export class FunctionalEntity extends ParallelEntity {
  // @functions is an object, with keys: setup, update, teardown, onSignal
  constructor(
    public functions: {
      setup: (
        frameInfo: FrameInfo,
        entityConfig: any,
        entity: FunctionalEntity
      ) => void
      update: (frameInfo: FrameInfo, entity: FunctionalEntity) => void
      teardown: (frameInfo: FrameInfo, entity: FunctionalEntity) => void
      onSignal: (
        frameInfo: FrameInfo,
        signal: string,
        data: any,
        entity: FunctionalEntity
      ) => void
      requestTransition: (frameInfo: FrameInfo, entity: FunctionalEntity) => any
    },
    childEntities: Entity[] = []
  ) {
    super()

    for (let childEntity of childEntities) this.addEntity(null, childEntity)
  }

  setup(frameInfo: FrameInfo, entityConfig: any) {
    super.setup(frameInfo, entityConfig)

    if (this.functions.setup)
      this.functions.setup(frameInfo, entityConfig, this)
  }

  update(frameInfo: FrameInfo) {
    super.update(frameInfo)

    if (this.functions.update) this.functions.update(frameInfo, this)
    if (this.functions.requestTransition) {
      this.requestedTransition = this.functions.requestTransition(
        frameInfo,
        this
      )
    }
  }

  teardown(frameInfo: FrameInfo) {
    if (this.functions.teardown) this.functions.teardown(frameInfo, this)

    super.teardown(frameInfo)
  }

  onSignal(frameInfo: FrameInfo, signal: string, data?: any) {
    super.onSignal(frameInfo, signal, data)

    if (this.functions.onSignal)
      this.functions.onSignal(frameInfo, signal, data, this)
  }
}

/**
  An entity that calls a provided function just once (in setup), and immediately requests a transition.
  Optionally takes a @that parameter, which is set as _this_ during the call. 
*/
export class FunctionCallEntity extends Entity {
  constructor(public f: (arg: any) => any, public that?: any) {
    super()
    this.that = that || this
  }

  _setup() {
    this.f.call(this.that)

    this.requestedTransition = true
  }
}

// Waits until time is up, then requests transition
export class WaitingEntity extends Entity {
  /** @wait is in milliseconds */
  constructor(public wait: number) {
    super()
  }

  _update(frameInfo: FrameInfo) {
    if (frameInfo.timeSinceStart >= this.wait) {
      this.requestedTransition = true
    }
  }
}

/**
  An entity that creates a new PIXI container in the setup entityConfig for it's children, and manages the container. 
*/
export class ContainerEntity extends ParallelEntity {
  public oldConfig: any
  public newConfig: any
  public container: PIXI.Container

  constructor(entities: Entity[] = [], public name?: string) {
    super(entities)
  }

  setup(frameInfo: FrameInfo, entityConfig: any) {
    this.oldConfig = entityConfig

    this.container = new PIXI.Container()
    this.container.name = this.name
    this.oldConfig.container.addChild(this.container)

    this.newConfig = {
      ...entityConfig,
      container: this.container,
    }

    super.setup(frameInfo, this.newConfig)
  }

  teardown(frameInfo: FrameInfo) {
    super.teardown(frameInfo)

    this.oldConfig.container.removeChild(this.container)
  }
}

/**
  Manages a video asset. Can optionally loop the video.
  Asks for a transition when the video has ended.
*/
export class VideoEntity extends Entity {
  public container: PIXI.Container
  public videoElement: any
  public videoSprite: any
  public loop: boolean

  constructor(public videoName: string, options: any = {}) {
    super()

    util.setupOptions(this, options, {
      loop: false,
    })
  }

  _setup(frameInfo: FrameInfo, entityConfig: EntityConfig) {
    // This container is used so that the video is inserted in the right place,
    // even if the sprite isn't added until later.
    this.container = new PIXI.Container()
    this.entityConfig.container.addChild(this.container)

    this.videoElement = this.entityConfig.videoAssets[this.videoName]
    this.videoElement.loop = this.loop
    this.videoElement.currentTime = 0

    this.videoSprite = null

    // videoElement.play() might not return a promise on older browsers
    Promise.resolve(this.videoElement.play()).then(() => {
      // Including a slight delay seems to workaround a bug affecting Firefox
      window.setTimeout(() => this._startVideo(), 100)
    })
  }

  _update(frameInfo: FrameInfo) {
    if (this.videoElement.ended) this.requestedTransition = true
  }

  _onSignal(frameInfo: FrameInfo, signal: string, data?: any) {
    if (signal === "pause") {
      this.videoElement.pause()
    } else if (signal === "play") {
      this.videoElement.play()
    }
  }

  teardown(frameInfo: FrameInfo) {
    this.videoElement.pause()
    this.videoSprite = null
    this.entityConfig.container.removeChild(this.container)
    this.container = null

    super.teardown(frameInfo)
  }

  _startVideo() {
    const videoResource = new PIXI.VideoResource(this.videoElement)
    this.videoSprite = PIXI.Sprite.from(videoResource.source)
    this.container.addChild(this.videoSprite)
  }
}

/** 
  Creates a toggle switch that has different textures in the "off" and "on" positions.
*/
export class ToggleSwitch extends Entity {
  public container: PIXI.Container
  public spriteOn: PIXI.Sprite
  public spriteOff: PIXI.Sprite
  public position: PIXI.Point
  public onTexture: PIXI.Texture
  public offTexture: PIXI.Texture
  public isOn: boolean

  constructor(options: any) {
    super()

    util.setupOptions(this, options, {
      onTexture: util.REQUIRED_OPTION,
      offTexture: util.REQUIRED_OPTION,
      isOn: false,
      position: new PIXI.Point(),
    })
  }

  setup(frameInfo: FrameInfo, entityConfig: any) {
    super.setup(frameInfo, entityConfig)

    this.container = new PIXI.Container()
    this.container.position.copyFrom(this.position)

    this.spriteOn = new PIXI.Sprite(this.onTexture)
    this.spriteOn.interactive = true
    this._on(this.spriteOn, "pointertap", this._turnOff)
    this.container.addChild(this.spriteOn)

    this.spriteOff = new PIXI.Sprite(this.offTexture)
    this.spriteOff.interactive = true
    this._on(this.spriteOff, "pointertap", this._turnOn)
    this.container.addChild(this.spriteOff)

    this._updateVisibility()

    this.entityConfig.container.addChild(this.container)
  }

  teardown(frameInfo: FrameInfo) {
    this.entityConfig.container.removeChild(this.container)

    super.teardown(frameInfo)
  }

  setIsOn(isOn: boolean, silent = false) {
    this.isOn = isOn
    this._updateVisibility()

    if (!silent) this.emit("change", this.isOn)
  }

  _turnOff() {
    this.isOn = false
    this._updateVisibility()
    this.emit("change", this.isOn)
  }

  _turnOn() {
    this.isOn = true
    this._updateVisibility()
    this.emit("change", this.isOn)
  }

  _updateVisibility() {
    this.spriteOn.visible = this.isOn
    this.spriteOff.visible = !this.isOn
  }
}

/** 
  Manages an animated sprite in PIXI, pausing the sprite during pauses.

  When the animation completes (if the animation is not set to loop, then this will request a transition)
*/
export class AnimatedSpriteEntity extends Entity {
  constructor(public animatedSprite: PIXI.AnimatedSprite) {
    super()
  }

  _setup() {
    if (this.animatedSprite.onComplete)
      console.warn("Warning: overwriting this.animatedSprite.onComplete")
    this.animatedSprite.onComplete = this._onAnimationComplete.bind(this)

    this.entityConfig.container.addChild(this.animatedSprite)
    this.animatedSprite.gotoAndPlay(0)
  }

  onSignal(frameInfo: FrameInfo, signal: string, data?: any) {
    if (signal == "pause") this.animatedSprite.stop()
    else if (signal == "play") this.animatedSprite.play()
  }

  _teardown(frameInfo: FrameInfo) {
    this.animatedSprite.stop()
    this.animatedSprite.onComplete = null
    this.entityConfig.container.removeChild(this.animatedSprite)
  }

  _onAnimationComplete() {
    this.requestedTransition = true
  }
}

export class SkipButton extends Entity {
  public sprite: PIXI.Sprite

  setup(frameInfo: FrameInfo, entityConfig: EntityConfig) {
    super.setup(frameInfo, entityConfig)

    this.sprite = new PIXI.Sprite(
      this.entityConfig.app.loader.resources[
        this.entityConfig.directives.graphics.skip as number
      ].texture
    )
    this.sprite.anchor.set(0.5)
    this.sprite.position.set(
      this.entityConfig.app.screen.width - 50,
      this.entityConfig.app.screen.height - 50
    )
    this.sprite.interactive = true
    this._on(this.sprite, "pointertap", this._onSkip)

    this.entityConfig.container.addChild(this.sprite)
  }

  teardown(frameInfo: FrameInfo) {
    this.entityConfig.container.removeChild(this.sprite)

    super.teardown(frameInfo)
  }

  _onSkip() {
    this.requestedTransition = true
    this.emit("skip")
  }
}

/**
  Similar in spirit to ParallelEntity, but does not hold onto entities that have completed. 
  Instead, entities that have completed are removed after teardown 
*/
export class DeflatingCompositeEntity extends Entity {
  public entities: Entity[] = []
  public autoTransition: boolean

  /** Options include:
        autoTransition: If true, requests transition when the entity has no children (default true)
  */
  constructor(options: any = {}) {
    super()

    util.setupOptions(this, options, {
      autoTransition: true,
    })
  }

  setup(frameInfo: FrameInfo, entityConfig: any) {
    super.setup(frameInfo, entityConfig)

    for (const entity of this.entities) {
      if (!entity.isSetup) {
        entity.setup(frameInfo, entityConfig)
      }
    }
  }

  update(frameInfo: FrameInfo) {
    super.update(frameInfo)

    // Slightly complicated for-loop so that we can remove entities that are complete
    for (let i = 0; i < this.entities.length; ) {
      const entity = this.entities[i]
      entity.update(frameInfo)

      if (entity.requestedTransition) {
        console.debug("Cleanup up child entity", entity)

        if (entity.isSetup) {
          entity.teardown(frameInfo)
        }

        this.entities.splice(i, 1)
      } else {
        i++
      }
    }

    if (this.autoTransition && this.entities.length == 0) {
      this.requestedTransition = true
    }
  }

  teardown(frameInfo: FrameInfo) {
    for (const entity of this.entities) {
      entity.teardown(frameInfo)
    }

    super.teardown(frameInfo)
  }

  onSignal(frameInfo: FrameInfo, signal: string, data?: any) {
    super.onSignal(frameInfo, signal, data)

    for (const entity of this.entities) {
      entity.onSignal(frameInfo, signal, data)
    }
  }

  addEntity(entity: Entity) {
    // If we have already been setup, setup this new entity
    if (this.isSetup && !entity.isSetup) {
      entity.setup(this.lastFrameInfo, this.entityConfig)
    }

    this.entities.push(entity)
  }

  removeEntity(entity: Entity) {
    const index = this.entities.indexOf(entity)
    if (index === -1) throw new Error("Cannot find entity to remove")

    if (entity.isSetup) {
      entity.teardown(this.lastFrameInfo)
    }

    this.entities.splice(index, 1)
  }
}

/**
 * Does not request a transition until done() is called with a given transition
 */
export class Block extends Entity {
  done(transition = true) {
    this.requestedTransition = transition
  }
}

/**
 * Executes a function once and requests a transition equal to its value.
 */
export class Decision extends Entity {
  constructor(private f: () => boolean) {
    super()
  }

  _setup() {
    this.requestedTransition = this.f()
  }
}

/**
 * Waits for an event to be delivered, and decides to request a transition depending on the event value.
 * @handler is a function of the event arguments, and should return a transition (or false if no transition)
 */
export class WaitForEvent extends Entity {
  constructor(
    public emitter: PIXI.utils.EventEmitter,
    public eventName: string,
    public handler: (...args: any) => boolean = () => true
  ) {
    super()
  }

  _setup() {
    this._on(this.emitter, this.eventName, this._handleEvent)
  }

  _handleEvent(...args: any) {
    this.requestedTransition = this.handler(...args)
  }
}

/**
 * A composite entity that requests a transition as soon as one of it's children requests one
 */
export class Alternative extends Entity {
  public entityPairs: { entity: Entity; transition: string }[]

  // Takes an array of type: { entity, transition } or just entity
  // transition defaults to the string version of the index in the array (to avoid problem of 0 being considered as falsy)
  constructor(
    entityPairs: (Entity | { entity: Entity; transition: string })[] = []
  ) {
    super()

    this.entityPairs = entityPairs.map((entityPair, key) => {
      if (entityPair instanceof Entity)
        return {
          entity: entityPair,
          transition: key.toString(),
        }

      // Assume an object of type { entity, transition }
      return {
        transition: key.toString(),
        ...entityPair,
      }
    })
  }

  _setup(frameInfo: FrameInfo) {
    for (const entityPair of this.entityPairs) {
      entityPair.entity.setup(frameInfo, this.entityConfig)
      if (entityPair.entity.requestedTransition)
        this.requestedTransition = entityPair.transition
    }
  }

  _update(frameInfo: FrameInfo) {
    for (const entityPair of this.entityPairs) {
      entityPair.entity.update(frameInfo)
      if (entityPair.entity.requestedTransition)
        this.requestedTransition = entityPair.transition
    }
  }

  _teardown(frameInfo: FrameInfo) {
    for (const entityPair of this.entityPairs) {
      entityPair.entity.teardown(frameInfo)
    }
  }
}

/**
 * A composite entity in which only entity is active at a time.
 * By default, the first entity is active
 */
export class SwitchingEntity extends Entity {
  public entities: Entity[] = []
  public entityConfigs: any[] = []
  public activeEntityIndex = -1

  constructor() {
    super()
  }

  setup(frameInfo: FrameInfo, entityConfig: any) {
    super.setup(frameInfo, entityConfig)

    if (this.entities && this.activeEntityIndex > 0) {
      this.switchToIndex(this.activeEntityIndex)
    }
  }

  update(frameInfo: FrameInfo) {
    super.update(frameInfo)

    if (this.activeEntityIndex >= 0) {
      this.entities[this.activeEntityIndex].update(frameInfo)
    }
  }

  teardown(frameInfo: FrameInfo) {
    this.switchToIndex(-1)

    super.teardown(frameInfo)
  }

  onSignal(frameInfo: FrameInfo, signal: string, data?: any) {
    super.onSignal(frameInfo, signal, data)

    if (this.activeEntityIndex >= 0) {
      this.entities[this.activeEntityIndex].onSignal(frameInfo, signal, data)
    }
  }

  // If entityConfig is provided, it will overload the entityConfig provided to this entity by setup()
  addEntity(entity: Entity, entityConfig?: any) {
    this.entities.push(entity)
    this.entityConfigs.push(entityConfig)
  }

  switchToIndex(index: number) {
    if (this.activeEntityIndex >= 0) {
      this.entities[this.activeEntityIndex].teardown(this.lastFrameInfo)
    }

    this.activeEntityIndex = index

    if (this.activeEntityIndex >= 0) {
      const entityConfig = processEntityConfig(
        this.entityConfig,
        this.entityConfigs[this.activeEntityIndex]
      )

      this.entities[this.activeEntityIndex].setup(
        this.lastFrameInfo,
        entityConfig
      )
    }
  }

  switchToEntity(entity: Entity) {
    if (entity === null) {
      this.switchToIndex(-1)
    } else {
      const index = this.entities.indexOf(entity)
      if (index === -1) throw new Error("Cannot find entity")

      this.switchToIndex(index)
    }
  }

  activeEntity() {
    if (this.activeEntityIndex >= 0)
      return this.entities[this.activeEntityIndex]

    return null
  }

  removeEntity(entity: Entity) {
    const index = this.entities.indexOf(entity)
    if (index === -1) throw new Error("Cannot find entity")

    if (index === this.activeEntityIndex) {
      this.switchToIndex(-1)
    }

    this.entities.splice(index, 1)
    this.entityConfigs.splice(index, 1)
  }

  removeAllEntities() {
    this.switchToIndex(-1)

    this.entities = []
    this.entityConfigs = []
    this.activeEntityIndex = -1
  }
}
