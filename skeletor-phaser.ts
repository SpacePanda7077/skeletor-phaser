/**
 * Skeletor for Phaser: plays the JSON exported by the editor with one line.
 *
 *   import "./skeletor-phaser";                       // adds this.add.skeleton() and this.load.skeleton()
 *
 *   preload() { this.load.skeleton("hero", "assets/hero/hero.json"); }   // also loads the images next to the json
 *   create()  { this.hero = this.add.skeleton(400, 500, "hero", "idle"); }
 *   update()  {
 *       this.hero.faceTowards(this.input.activePointer.worldX, 0.12);   // flip left / right
 *       this.hero.play(moving ? "run" : "idle", { fade: 0.15 });        // crossfade, safe to call every frame
 *       this.hero.aimBone("arm", pointer.worldX, pointer.worldY);       // procedural aiming on top of the animation
 *       this.hero.setIKTarget("Left leg", groundX, groundY);            // IK from the editor: the leg reaches this point
 *   }
 *
 * Needs only ./format (types). Copy this file + format.ts into your game.
 * Same maths as runtime.ts (same keys, same blending, same hierarchy), but allocation free per frame.
 *
 * The rig is authored around (0, 0) in the editor: (0, 0) is where add.skeleton(x, y) puts it, so build your
 * character with its feet (or whatever you want to stand on) at the origin.
 */
import {
    GameObjects,
    Loader,
    Math as PhaserMath,
    Plugins,
    Scene,
    Tweens,
} from "phaser";
import type {
    ExportAnimation,
    ExportBone,
    ExportData,
    ExportKey,
} from "./format";

export type Facing = "left" | "right";

/** a bone's current transform */
export type BonePose = {
    x: number;
    y: number;
    rotation: number;
    tipX: number;
    tipY: number;
};

export type PlayOptions = {
    /** seconds to crossfade from whatever is playing now (default 0 = cut) */
    fade?: number;
    /** override the animation's own loop flag */
    loop?: boolean;
    /** 1 = normal, 2 = twice as fast */
    speed?: number;
    /** start this many seconds in */
    startTime?: number;
    /** play from the start even if this animation is already the current one */
    restart?: boolean;
};

export type SkeletonOptions = {
    /** animation to start with */
    animation?: string;
    speed?: number;
    /** which way it should face first (default: the way it was drawn) */
    facing?: Facing;
    /** which way the art faces in the editor (default "right"); setFacing flips relative to this */
    authoredFacing?: Facing;
    /** start with the sprite parts affected by the scene's lights (see setLit) */
    lit?: boolean;
};

export type LayerOptions = {
    /** only these bones (and, by default, everything below them) play the animation, e.g. ["spine"] for an upper body. Default: all bones */
    bones?: string[];
    /** include the bones below the listed ones (default true) */
    children?: boolean;
    /** leave these bones (and the ones below them, if children) out, e.g. except: ["arm_L"] */
    except?: string[];
    /**
     * "replace" (default): the layer takes over the masked bones that it has keys for.
     * "add": its movement is added on top of what is already playing (breathing, a flinch, a hit reaction).
     */
    mode?: "replace" | "add";
    /**
     * Which layer wins where two layers touch the same bone: the higher number is applied last, so it wins (default 0).
     * Layers with the same number: the one started later wins. Give a throw priority 1 and an "idle upper body" layer 0.
     */
    priority?: number;
    /** 0..1: how strongly it applies (default 1). Calling again with another weight changes it */
    weight?: number;
    /** seconds to fade in (default 0.1) */
    fade?: number;
    /** seconds to fade out at the end of a non-looping animation, or when stopLayer is called (default = fade) */
    fadeOut?: number;
    loop?: boolean;
    speed?: number;
    startTime?: number;
    /** start over even if this animation is already playing in this slot */
    restart?: boolean;
    /**
     * true (default): only bones the animation has keys for are touched, so the rest keeps playing the base animation
     * (a throw that only keys the arm leaves the legs running). false: every masked bone is forced to this animation,
     * a bone with no keys goes to its setup pose.
     */
    keyedOnly?: boolean;
};

export type PlantOptions = {
    /**
     * Your ground check (a raycast): given a WORLD point near the foot, return the world y of the ground under it, or
     * null if there is none (then the animation plays untouched).
     */
    ground: (worldX: number, worldY: number) => number | null;
    /** the bone whose tip is checked against the ground (a foot bone below the IK chain). Default: the IK's lower bone */
    bone?: string;
    /** the world y of the flat ground the animation was made for. Default: the skeleton's own y (its feet) */
    groundLevel?: number | (() => number);
    /**
     * how close to the flat ground the animated foot must be to count as "planted", in pixels (default 48).
     * Higher = the foot sticks to the ground for longer in each step, lower = only when it really touches.
     */
    plantHeight?: number;
    /** keep the foot this many pixels above the ground (default 0) */
    offset?: number;
    /** never move the foot more than this many pixels up or down from the animation (default 100) */
    maxShift?: number;
    /** seconds to ease the plant on and off, so the foot doesn't pop (default 0.05; 0 = none) */
    smooth?: number;
};

/** what plantBone decided on the last update, for debugging (read it with getPlantInfo) */
export type PlantInfo = {
    /** the IK this belongs to */
    ik: string;
    /** the bone whose tip is checked against the ground */
    bone: string;
    /** your ground check found ground under the foot this frame */
    hit: boolean;
    /** the ground y your check returned (null = no ground) */
    groundY: number | null;
    /** world: the tip of `bone` as the animation alone places it. This is the point your ground check was asked about */
    footX: number;
    footY: number;
    /** world: the tip of the IK chain's lower bone as the animation places it (what the IK moves) */
    chainX: number;
    chainY: number;
    /** world: where the chain tip is sent this frame (chain tip + shift) */
    targetX: number;
    targetY: number;
    /** the flat ground line used (groundLevel) */
    level: number;
    /** how high the animated foot is above that line (level - footY); 0 = on it, negative = below it */
    lift: number;
    /** pixels the foot is moved up (negative) or down (positive) to meet the ground, after offset and maxShift */
    shift: number;
    /** maxShift cut the movement short */
    clamped: boolean;
    /** 0..1: how planted the animation says the foot is (1 = on the floor, 0 = swinging) */
    planted: number;
    /** the IK weight actually used (planted, eased by `smooth`) */
    weight: number;
};

export type BoneOverrideOptions = {
    /** 0..1, how much the override wins over the animation (default 1) */
    weight?: number;
    /** keep the bone within this many radians of its setup rotation (e.g. a head that can't turn around) */
    limit?: number;
};

export const SkeletonEvents = {
    /** (name) a play() started */
    START: "animationstart",
    /** (name) a non-looping animation reached its end */
    COMPLETE: "animationcomplete",
    /** (name) a looping animation wrapped around */
    LOOP: "animationloop",
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// maths (mirrors runtime.ts)
// ---------------------------------------------------------------------------------------------------------------------

const TAU = Math.PI * 2;

/** the short way round, never more than half a turn */
function lerpAngle(a: number, b: number, t: number): number {
    let d = (b - a) % TAU;
    if (d > Math.PI) d -= TAU;
    else if (d < -Math.PI) d += TAU;
    return a + d * t;
}

/** angle into -PI..PI */
function wrapAngle(a: number): number {
    let d = a % TAU;
    if (d > Math.PI) d -= TAU;
    else if (d < -Math.PI) d += TAU;
    return d;
}

/** scratch result of sampleInto (rotation, x, y offsets) */
const S = { r: 0, x: 0, y: 0 };

/** pose offsets of one bone at `frame` into S (holds the first / last key outside the range) */
function sampleInto(keys: ExportKey[], frame: number) {
    const n = keys.length;
    let a = keys[0];
    if (frame <= a.frame || n === 1) {
        S.r = a.rotation;
        S.x = a.x;
        S.y = a.y;
        return;
    }
    a = keys[n - 1];
    if (frame >= a.frame) {
        S.r = a.rotation;
        S.x = a.x;
        S.y = a.y;
        return;
    }
    // keys[lo].frame <= frame < keys[hi].frame
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (keys[mid].frame <= frame) lo = mid;
        else hi = mid;
    }
    a = keys[lo];
    const b = keys[hi];
    if (a.interp === "step") {
        S.r = a.rotation;
        S.x = a.x;
        S.y = a.y;
        return;
    }
    let t = (frame - a.frame) / (b.frame - a.frame);
    if (a.interp === "smooth") t = t * t * (3 - 2 * t);
    S.r = lerpAngle(a.rotation, b.rotation, t);
    S.x = a.x + (b.x - a.x) * t;
    S.y = a.y + (b.y - a.y) * t;
}

/** scratch result of solveTwoBone (world angles of the upper and the lower bone) */
const IK = { a: 0, b: 0 };

/**
 * Analytic 2-bone IK, the same maths as the editor's solve2BoneIK. `side` (+1 / -1) is which side of the
 * root -> target line the joint bends to. Out of reach, the chain stretches straight at the target.
 */
function solveTwoBone(
    rx: number,
    ry: number,
    lenA: number,
    lenB: number,
    tx: number,
    ty: number,
    side: number,
): boolean {
    if (lenA <= 0 || lenB <= 0) return false;
    const dx = tx - rx;
    const dy = ty - ry;
    let dist = Math.hypot(dx, dy);
    const maxReach = lenA + lenB - 1e-4;
    const minReach = Math.abs(lenA - lenB) + 1e-4;
    if (dist > maxReach) dist = maxReach;
    if (dist < minReach) dist = minReach;
    if (dist < 1e-6) return false;

    const cosMid =
        (lenA * lenA + dist * dist - lenB * lenB) / (2 * lenA * dist);
    const mid = Math.acos(Math.max(-1, Math.min(1, cosMid)));
    const angleA = Math.atan2(dy, dx) + side * mid;
    const mx = rx + Math.cos(angleA) * lenA;
    const my = ry + Math.sin(angleA) * lenA;
    IK.a = angleA;
    IK.b = Math.atan2(ty - my, tx - mx);
    return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// the rig: everything about a file that can be shared by every skeleton made from it
// ---------------------------------------------------------------------------------------------------------------------

type Anim = {
    name: string;
    src: ExportAnimation;
    /** keys per bone index (undefined = this animation doesn't touch the bone) */
    tracks: (ExportKey[] | undefined)[];
};

type IKDef = {
    name: string;
    /** names of the target / pole objects from the editor */
    target: string;
    pole: string;
    /** bone indices: upper, lower */
    a: number;
    b: number;
    bend: number;
};

type Rig = {
    data: ExportData;
    bones: ExportBone[];
    ik: IKDef[];
    ikByName: Map<string, number>;
    targetByName: Map<string, number>;
    poleByName: Map<string, number>;
    /** per bone: index of the IK it is the upper / lower bone of, -1 = none */
    ikA: Int32Array;
    ikB: Int32Array;
    /** parent bone index, -1 for roots (bones are listed parents first) */
    parent: Int32Array;
    index: Map<string, number>;
    /** bone index of every part, -1 = free */
    partBone: Int32Array;
    anims: Map<string, Anim>;
};

const rigs = new WeakMap<ExportData, Rig>();

function rigOf(data: ExportData): Rig {
    let rig = rigs.get(data);
    if (rig) return rig;
    if (data.format !== "animation_tool")
        throw new Error(
            '[skeletor] this is not an exported animation_tool file (format !== "animation_tool")',
        );

    const bones = data.bones;
    const index = new Map<string, number>();
    bones.forEach((b, i) => index.set(b.name, i));
    const parent = new Int32Array(bones.length);
    bones.forEach(
        (b, i) =>
            (parent[i] = b.parent === null ? -1 : (index.get(b.parent) ?? -1)),
    );
    const partBone = new Int32Array(data.parts.length);
    data.parts.forEach(
        (p, i) =>
            (partBone[i] = p.bone === null ? -1 : (index.get(p.bone) ?? -1)),
    );

    const ik: IKDef[] = [];
    const ikByName = new Map<string, number>();
    const targetByName = new Map<string, number>();
    const poleByName = new Map<string, number>();
    const ikA = new Int32Array(bones.length).fill(-1);
    const ikB = new Int32Array(bones.length).fill(-1);
    for (const c of data.ik ?? []) {
        const a = index.get(c.boneA);
        const b = index.get(c.boneB);
        if (a === undefined || b === undefined || parent[b] !== a) {
            console.warn(
                `[skeletor] IK "${c.name}" needs two bones where the second is a child of the first, skipping it`,
            );
            continue;
        }
        ikA[a] = ik.length;
        ikB[b] = ik.length;
        ikByName.set(c.name, ik.length);
        const target = c.target ?? `${c.name} target`;
        const pole = c.pole ?? `${c.name} pole`;
        targetByName.set(target, ik.length);
        poleByName.set(pole, ik.length);
        ik.push({
            name: c.name,
            target,
            pole,
            a,
            b,
            bend: c.bend < 0 ? -1 : 1,
        });
    }

    const anims = new Map<string, Anim>();
    for (const [name, src] of Object.entries(data.animations)) {
        anims.set(name, {
            name,
            src,
            tracks: bones.map((b) => {
                const k = src.bones[b.name];
                return k && k.length ? k : undefined;
            }),
        });
    }

    rig = {
        data,
        bones,
        ik,
        ikByName,
        targetByName,
        poleByName,
        ikA,
        ikB,
        parent,
        index,
        partBone,
        anims,
    };
    rigs.set(data, rig);
    return rig;
}

/** image file names a file needs (what the editor wrote into the sprite parts) */
function imageNames(data: ExportData): Set<string> {
    const names = new Set<string>();
    for (const p of data.parts)
        if (p.type === "sprite" && p.image) names.add(p.image);
    return names;
}

// ---------------------------------------------------------------------------------------------------------------------
// the game object
// ---------------------------------------------------------------------------------------------------------------------

/** one animation being played; several at once while crossfading or blending */
type Layer = {
    name: string;
    anim: ExportAnimation;
    tracks: (ExportKey[] | undefined)[];
    /** seconds */
    dur: number;
    /** seconds into the animation (not wrapped) */
    time: number;
    speed: number;
    loop: boolean;
    weight: number;
    target: number;
    /** weight change per second towards target */
    rate: number;
    /** a non-looping animation that reached its end (COMPLETE was emitted) */
    done: boolean;
    /** driven by the shared blend phase instead of its own clock */
    synced: boolean;
    /** frame to sample, set once per update */
    frame: number;
};

type Override = {
    mode: "add" | "local" | "world" | "aim";
    /** radians (add / local / world) */
    value: number;
    /** aim: world position to point at */
    wx: number;
    wy: number;
    /** aim: radians added to the angle (for art that doesn't point along its bone) */
    offset: number;
    weight: number;
    limit: number | undefined;
};

/** any Phaser object with a position: a sprite, a physics body's sprite, a Zone ... */
export type IKFollower = GameObjects.GameObject & {
    x: number;
    y: number;
    setPosition(x?: number, y?: number): unknown;
    parentContainer: GameObjects.Container | null;
    getWorldTransformMatrix(
        tempMatrix?: GameObjects.Components.TransformMatrix,
        parentMatrix?: GameObjects.Components.TransformMatrix,
    ): GameObjects.Components.TransformMatrix;
};

/** what the game told one IK constraint, plus the result of the last solve */
type IKState = {
    hasTarget: boolean;
    /** objects the chain follows (world position, read every frame); tZone / pZone are the ones made by getIKTarget / getIKPole */
    tObj: IKFollower | null;
    pObj: IKFollower | null;
    tZone: GameObjects.Zone | null;
    pZone: GameObjects.Zone | null;
    /** world */
    tx: number;
    ty: number;
    hasPole: boolean;
    px: number;
    py: number;
    bend: number;
    /** 0 = the animation, 1 = full IK */
    weight: number;
    weightTarget: number;
    weightRate: number;
    /** solved this update: the lower bone reads angleB */
    solved: boolean;
    angleA: number;
    angleB: number;
};

type Plant = {
    ik: number;
    /** bone index checked against the ground */
    sample: number;
    opts: PlantOptions;
    info: PlantInfo;
};

/** an animation playing on top of the base one, on some bones only (see playLayer) */
type Overlay = Layer & {
    slot: string;
    /** per bone, 0..1 (0 = not affected) */
    mask: Float32Array;
    mode: "replace" | "add";
    keyedOnly: boolean;
    /** the weight it fades to */
    strength: number;
    priority: number;
    fadeOut: number;
    /** fading out because it was stopped or replaced */
    leaving: boolean;
    /** fading out because it reached its end (the animation completed on its own) */
    ending: boolean;
    /** replaced by a newer animation in the same slot: it holds its weight until that one is fully in, then fades */
    replacedBy: Overlay | null;
};

/** an object glued to a bone (see attachToBone) */
type Attachment = {
    obj: GameObjects.GameObject & {
        x: number;
        y: number;
        rotation: number;
        setPosition(x?: number, y?: number): unknown;
        setRotation(r?: number): unknown;
    };
    bone: number;
    /** where along the bone it sits: 0 = the pivot (start), 1 = the tip (end) */
    along: number;
    x: number;
    y: number;
    rotation: number;
    followRotation: boolean;
};

export type AttachOptions = {
    /** draw just BELOW this part (by its name in the editor), e.g. a gun under the right hand */
    below?: string;
    /** draw just ABOVE this part */
    above?: string;
    /**
     * Where on the bone it is glued: "pivot" (the start of the bone, default), "tip" (the end of the bone), or a
     * number along it: 0 = pivot, 0.5 = the middle, 1 = tip.
     */
    at?: "pivot" | "tip" | number;
    /** offset from that point, in the bone's own space (x along the bone, y across it) */
    x?: number;
    y?: number;
    /** extra rotation in radians */
    rotation?: number;
    /** false = only follow the bone's position, keep the object's own rotation (default true) */
    followRotation?: boolean;
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function frameOf(l: Layer): number {
    const a = l.anim;
    if (a.end <= 0) return 0;
    const f = Math.max(0, l.time) * a.fps;
    return l.loop ? f % a.end : Math.min(f, a.end);
}

export class Skeleton extends GameObjects.Container {
    /** the exported file */
    readonly rigData: ExportData;
    private rig: Rig;
    private partObjects: (GameObjects.Image | GameObjects.Rectangle)[];

    // solved bones in the skeleton's own space (before this object's position / flip / scale)
    private wx: Float64Array;
    private wy: Float64Array;
    private wr: Float64Array;
    private wc: Float64Array;
    private ws: Float64Array;

    private layers: Layer[] = [];
    private currentName: string | null = null;
    private isPaused = false;
    private playbackSpeed = 1;
    /** shared 0..1 position of blended (synced) layers */
    private phase = 0;
    private blendSpeed = 1;
    private pending: [string, string, string?][] = [];
    /** animations playing on top of the base one, on some bones only */
    private overlays: Overlay[] = [];

    private overrides: (Override | undefined)[];
    private overrideCount = 0;
    private iks: IKState[];
    /** true only while getAnimatedBoneWorld() poses the skeleton without IK */
    private ikOff = false;
    /** feet kept on the ground by plantBone() */
    private plants: Plant[] = [];
    private lit = false;
    /** objects glued to bones by attachToBone() */
    private attachments: Attachment[] = [];
    private partIndexByName: Map<string, number>;

    private _facing: Facing;
    private authored: Facing;
    private mag = 1;
    private turnTween: Tweens.Tween | null = null;

    private m1 = new GameObjects.Components.TransformMatrix();
    private m2 = new GameObjects.Components.TransformMatrix();
    private m3 = new GameObjects.Components.TransformMatrix();
    private m4 = new GameObjects.Components.TransformMatrix();
    private pt = new PhaserMath.Vector2();

    constructor(
        scene: Scene,
        x: number,
        y: number,
        source: string | ExportData,
        options?: string | SkeletonOptions,
    ) {
        super(scene, x, y);
        const opts: SkeletonOptions =
            typeof options === "string"
                ? { animation: options }
                : (options ?? {});

        let data: ExportData;
        if (typeof source === "string") {
            data = scene.cache.json.get(source);
            if (!data)
                throw new Error(
                    `[skeletor] nothing loaded under "${source}". Call this.load.skeleton("${source}", "path/file.json") in preload().`,
                );
        } else data = source;
        this.rigData = data;
        const rig = (this.rig = rigOf(data));

        const n = rig.bones.length;
        this.wx = new Float64Array(n);
        this.wy = new Float64Array(n);
        this.wr = new Float64Array(n);
        this.wc = new Float64Array(n);
        this.ws = new Float64Array(n);
        this.overrides = new Array(n).fill(undefined);
        this.iks = rig.ik.map((d) => ({
            hasTarget: false,
            tObj: null,
            pObj: null,
            tZone: null,
            pZone: null,
            tx: 0,
            ty: 0,
            hasPole: false,
            px: 0,
            py: 0,
            bend: d.bend,
            weight: 0,
            weightTarget: 0,
            weightRate: 0,
            solved: false,
            angleA: 0,
            angleB: 0,
        }));

        // one game object per part, in draw order (back to front)
        this.partObjects = data.parts.map((p) => {
            let obj: GameObjects.Image | GameObjects.Rectangle;
            if (
                p.type === "sprite" &&
                p.image &&
                scene.textures.exists(p.image)
            ) {
                obj = new GameObjects.Image(
                    scene,
                    0,
                    0,
                    p.image,
                ).setDisplaySize(p.width, p.height);
            } else {
                if (p.type === "sprite")
                    console.warn(
                        `[skeletor] image "${p.image}" is not loaded, drawing a magenta box instead. ` +
                            `Use this.load.skeleton() or load it under that exact name.`,
                    );
                const color =
                    p.type === "sprite"
                        ? 0xff00ff
                        : parseInt(p.color.slice(1), 16);
                obj = new GameObjects.Rectangle(
                    scene,
                    0,
                    0,
                    p.width,
                    p.height,
                    color,
                );
            }
            obj.setVisible(p.visible);
            return obj;
        });
        this.add(this.partObjects);
        if (opts.lit) this.setLit(true);
        this.partIndexByName = new Map();
        data.parts.forEach((p, i) => {
            if (!this.partIndexByName.has(p.name))
                this.partIndexByName.set(p.name, i);
        });

        this.authored = opts.authoredFacing ?? "right";
        this._facing = this.authored;
        if (opts.speed !== undefined) this.playbackSpeed = opts.speed;
        if (opts.facing && opts.facing !== this._facing)
            this.setFacing(opts.facing);

        this.applyPose(); // the setup pose until something plays
        if (opts.animation) this.play(opts.animation);
    }

    // ------------------------------------------------------------------------------------------------ animations

    /** names of all animations in the file */
    getAnimationNames(): string[] {
        return [...this.rig.anims.keys()];
    }

    has(name: string): boolean {
        return this.rig.anims.has(name);
    }

    /** name of the animation that is playing (the newest one while crossfading), null when stopped or blending */
    get animation(): string | null {
        return this.currentName;
    }

    isPlaying(name?: string): boolean {
        const cur = this.currentLayer();
        if (!cur || this.isPaused) return false;
        return name === undefined || cur.name === name;
    }

    /**
     * Play an animation. Calling it every frame with the same name is fine (it keeps playing; a non-looping one plays
     * once and holds its last frame). To play it again from the start, call play(name, { restart: true }).
     * With `fade` the old animation keeps moving while it fades out, so walk -> run stays smooth.
     */
    play(name: string, opts: PlayOptions = {}): this {
        const anim = this.rig.anims.get(name);
        if (!anim) {
            console.warn(
                `[skeletor] no animation called "${name}" (the file has: ${this.getAnimationNames().join(", ")})`,
            );
            return this;
        }
        const cur = this.currentLayer();
        // same animation already current: keep it going. This includes a non-looping one that has FINISHED: it stays on
        // its last frame instead of starting over, so play("throw") in update() plays once. Use { restart: true } to retrigger.
        if (!opts.restart && cur && cur.name === name) {
            if (opts.speed !== undefined) cur.speed = opts.speed;
            return this;
        }

        const layer: Layer = {
            name,
            anim: anim.src,
            tracks: anim.tracks,
            dur: anim.src.fps > 0 ? anim.src.end / anim.src.fps : 0,
            time: opts.startTime ?? 0,
            speed: opts.speed ?? 1,
            loop: opts.loop ?? anim.src.loop,
            weight: 1,
            target: 1,
            rate: 0,
            done: false,
            synced: false,
            frame: 0,
        };

        const fade = Math.max(0, opts.fade ?? 0);
        if (fade > 0 && this.layers.length) {
            for (const l of this.layers) {
                l.target = 0;
                l.rate = l.weight / fade;
            }
            layer.weight = 0;
            layer.rate = 1 / fade;
        } else {
            this.layers.length = 0; // a cut
        }
        this.layers.push(layer);
        this.currentName = name;
        this.applyPose();
        this.emit(SkeletonEvents.START, name);
        return this;
    }

    /**
     * Mix several animations at once, e.g. blend({ walk: 0.3, run: 0.7 }) from your speed. Weights are relative.
     * Blended animations share one phase so their steps stay in sync even when they have different lengths.
     * Call it every frame with new weights, or once with `fade` to ease into the mix.
     */
    blend(
        weights: Record<string, number>,
        opts: { speed?: number; fade?: number } = {},
    ): this {
        const fade = Math.max(0, opts.fade ?? 0);
        if (opts.speed !== undefined) this.blendSpeed = opts.speed;

        // continue from where the strongest current animation is
        if (!this.layers.some((l) => l.synced)) {
            let lead: Layer | null = null;
            for (const l of this.layers)
                if (!lead || l.weight > lead.weight) lead = l;
            this.phase =
                lead && lead.dur > 0
                    ? (((lead.time / lead.dur) % 1) + 1) % 1
                    : 0;
        }

        // anything not mentioned fades out
        for (const l of this.layers) {
            if (l.name in weights && l.target > 0) continue;
            l.target = 0;
            if (fade > 0) l.rate = l.weight / fade;
            else l.weight = 0;
        }

        for (const [name, w] of Object.entries(weights)) {
            const anim = this.rig.anims.get(name);
            if (!anim) {
                console.warn(
                    `[skeletor] no animation called "${name}" (the file has: ${this.getAnimationNames().join(", ")})`,
                );
                continue;
            }
            let l = this.layers.find((x) => x.name === name && x.target > 0);
            if (!l) {
                l = {
                    name,
                    anim: anim.src,
                    tracks: anim.tracks,
                    dur: anim.src.fps > 0 ? anim.src.end / anim.src.fps : 0,
                    time: 0,
                    speed: 1,
                    loop: true,
                    weight: fade > 0 ? 0 : w,
                    target: w,
                    rate: 0,
                    done: false,
                    synced: true,
                    frame: 0,
                };
                this.layers.push(l);
            }
            l.synced = true;
            l.loop = true;
            l.target = Math.max(0, w);
            if (fade > 0) l.rate = Math.abs(l.target - l.weight) / fade;
            else l.weight = l.target;
        }
        this.currentName = null;
        this.applyPose();
        return this;
    }

    /** stop everything: back to the setup pose */
    stop(): this {
        this.layers.length = 0;
        this.overlays.length = 0;
        this.currentName = null;
        this.applyPose();
        return this;
    }

    pause(): this {
        this.isPaused = true;
        return this;
    }

    resume(): this {
        this.isPaused = false;
        return this;
    }

    /** speed of everything on this skeleton (1 = normal, 0.5 = slow motion) */
    setTimeScale(s: number): this {
        this.playbackSpeed = s;
        return this;
    }

    /** jump the current animation to a time in seconds (e.g. to sync two characters) */
    setTime(seconds: number): this {
        const cur = this.currentLayer();
        if (cur) {
            cur.time = seconds;
            cur.done = false;
        }
        this.applyPose();
        return this;
    }

    // ------------------------------------------------------------------------------------------------ layers (mix two animations)

    /**
     * Play an animation on top of the base one, on some bones only: throw with the upper body while the legs run,
     * heal while walking, reload while aiming.
     *   hero.play("run");                                                      // the base: always running
     *   hero.playLayer("upper", "throw", { bones: ["spine"], loop: false });   // the spine and everything above it throws
     * `slot` is a name for the layer ("upper", "face" ...): each slot plays one animation, a new one in the same slot
     * crossfades from the old one, and different slots can play at the same time. Calling it every frame with the
     * same animation is fine (it keeps playing). A non-looping animation fades out by itself at its end.
     * The animation only needs keys for the bones that should move; the others keep playing the base animation.
     */
    playLayer(slot: string, name: string, opts: LayerOptions = {}): this {
        const anim = this.rig.anims.get(name);
        if (!anim) {
            console.warn(
                `[skeletor] no animation called "${name}" (the file has: ${this.getAnimationNames().join(", ")})`,
            );
            return this;
        }
        const fade = Math.max(0, opts.fade ?? 0.1);
        const strength = clamp01(opts.weight ?? 1);

        const live = this.overlays.find(
            (o) => o.slot === slot && o.target > 0 && !o.leaving && !o.ending,
        );
        if (live && live.name === name && !opts.restart && !live.done) {
            if (opts.speed !== undefined) live.speed = opts.speed;
            if (opts.weight !== undefined && live.strength !== strength) {
                live.strength = strength;
                live.target = strength;
                live.rate =
                    Math.abs(strength - live.weight) / Math.max(fade, 1e-4);
            }
            return this;
        }

        const mask = this.maskFor(opts);
        if (!mask) return this;

        const layer: Overlay = {
            name,
            anim: anim.src,
            tracks: anim.tracks,
            dur: anim.src.fps > 0 ? anim.src.end / anim.src.fps : 0,
            time: opts.startTime ?? 0,
            speed: opts.speed ?? 1,
            loop: opts.loop ?? anim.src.loop,
            weight: fade > 0 ? 0 : strength,
            target: strength,
            rate: fade > 0 ? strength / fade : 0,
            done: false,
            synced: false,
            frame: 0,
            slot,
            mask,
            mode: opts.mode ?? "replace",
            keyedOnly: opts.keyedOnly ?? true,
            strength,
            priority: opts.priority ?? 0,
            fadeOut: Math.max(0, opts.fadeOut ?? fade),
            leaving: false,
            ending: false,
            replacedBy: null,
        };
        // the old animation of this slot stays under the new one until that is fully in, so the crossfade doesn't dip
        for (const o of this.overlays) {
            if (o.slot !== slot || o.leaving || o.ending) continue;
            o.leaving = true;
            o.target = o.weight;
            o.rate = 0;
            o.replacedBy = layer;
        }
        this.overlays.push(layer);
        this.overlays.sort((a, b) => a.priority - b.priority); // stable: same priority keeps start order
        this.applyPose();
        this.emit(SkeletonEvents.START, name, slot);
        return this;
    }

    /** fade a layer out and remove it (all layers without a slot name). */
    stopLayer(slot?: string, fadeSeconds = 0.1): this {
        for (let i = this.overlays.length - 1; i >= 0; i--) {
            const o = this.overlays[i];
            if (slot !== undefined && o.slot !== slot) continue;
            if (fadeSeconds > 0) {
                o.target = 0;
                o.rate = o.weight / fadeSeconds;
                o.leaving = true;
                o.replacedBy = null;
            } else this.overlays.splice(i, 1);
        }
        this.applyPose();
        return this;
    }

    /** is something playing in this layer slot (optionally: this animation) */
    isLayerPlaying(slot: string, name?: string): boolean {
        return this.overlays.some(
            (o) =>
                o.slot === slot &&
                !o.leaving &&
                o.target > 0 &&
                (name === undefined || o.name === name),
        );
    }

    /** which bones a layer touches (null + a warning if a bone name is wrong) */
    private maskFor(opts: LayerOptions): Float32Array | null {
        const rig = this.rig;
        const n = rig.bones.length;
        const mask = new Float32Array(n);
        const kids = opts.children ?? true;
        const mark = (names: string[]): Uint8Array | null => {
            const flag = new Uint8Array(n);
            for (const name of names) {
                const i = rig.index.get(name);
                if (i === undefined) {
                    console.warn(
                        `[skeletor] no bone called "${name}" (the file has: ${rig.bones.map((b) => b.name).join(", ")})`,
                    );
                    return null;
                }
                flag[i] = 1;
            }
            // bones are listed parents first, so one pass passes the flag down
            if (kids)
                for (let i = 0; i < n; i++) {
                    const p = rig.parent[i];
                    if (p >= 0 && flag[p]) flag[i] = 1;
                }
            return flag;
        };
        const inc = opts.bones && opts.bones.length ? mark(opts.bones) : null;
        if (opts.bones && opts.bones.length && !inc) return null;
        const exc =
            opts.except && opts.except.length ? mark(opts.except) : null;
        if (opts.except && opts.except.length && !exc) return null;
        for (let i = 0; i < n; i++)
            mask[i] = (inc ? inc[i] : 1) && !(exc && exc[i]) ? 1 : 0;
        return mask;
    }

    private currentLayer(): Layer | null {
        for (let i = this.layers.length - 1; i >= 0; i--) {
            const l = this.layers[i];
            if (l.target > 0 && !l.synced) return l;
        }
        return null;
    }

    // ------------------------------------------------------------------------------------------------ facing

    /** "left" or "right" */
    get facing(): Facing {
        return this._facing;
    }

    /**
     * Flip to face left or right (a mirror of the whole character, sprites included).
     * With turnSeconds > 0 it squashes through the middle over that time instead of snapping.
     */
    setFacing(dir: Facing, turnSeconds = 0): this {
        this._facing = dir;
        this.turnTween?.stop();
        this.turnTween = null;
        const mag = Math.abs(this.scaleX) || this.mag;
        this.mag = mag;
        const target = (dir === this.authored ? 1 : -1) * mag;
        if (turnSeconds > 0 && this.scaleX !== target) {
            this.turnTween = this.scene.tweens.add({
                targets: this,
                scaleX: target,
                duration: turnSeconds * 1000,
                ease: "Sine.easeInOut",
                onComplete: () => {
                    this.turnTween = null;
                },
            });
        } else {
            this.scaleX = target;
        }
        return this;
    }

    faceLeft(turnSeconds = 0): this {
        return this._facing === "left"
            ? this
            : this.setFacing("left", turnSeconds);
    }

    faceRight(turnSeconds = 0): this {
        return this._facing === "right"
            ? this
            : this.setFacing("right", turnSeconds);
    }

    flip(turnSeconds = 0): this {
        return this.setFacing(
            this._facing === "left" ? "right" : "left",
            turnSeconds,
        );
    }

    /** face a world x position (ignored while within deadZone pixels of it, so it doesn't jitter) */
    faceTowards(worldX: number, turnSeconds = 0, deadZone = 1): this {
        if (Math.abs(worldX - this.x) < deadZone) return this;
        return worldX < this.x
            ? this.faceLeft(turnSeconds)
            : this.faceRight(turnSeconds);
    }

    // ------------------------------------------------------------------------------------------------ bone overrides

    /**
     * Steer a bone by code on top of the animation (procedural animation).
     *   "add"   : turn it by `radians` more than the animation does (e.g. breathing, recoil)
     *   "local" : set its rotation relative to its parent
     *   "world" : set its rotation in the skeleton's space
     * Stays active until clearBoneOverride().
     */
    setBoneRotation(
        bone: string,
        radians: number,
        mode: "add" | "local" | "world" = "add",
        opts: BoneOverrideOptions = {},
    ): this {
        return this.setOverride(
            bone,
            { mode, value: radians, wx: 0, wy: 0, offset: 0 },
            opts,
        );
    }

    /**
     * Point a bone at a world position (aiming, looking). Call it every frame with the target's position.
     * `offset` (radians) is for art that doesn't point along its bone; `limit` keeps it within that many radians of rest.
     * Flipping is handled: aiming while facing left just works.
     */
    aimBone(
        bone: string,
        worldX: number,
        worldY: number,
        opts: BoneOverrideOptions & { offset?: number } = {},
    ): this {
        return this.setOverride(
            bone,
            {
                mode: "aim",
                value: 0,
                wx: worldX,
                wy: worldY,
                offset: opts.offset ?? 0,
            },
            opts,
        );
    }

    /** remove the override of one bone, or of all bones */
    clearBoneOverride(bone?: string): this {
        if (bone === undefined) {
            this.overrides.fill(undefined);
            this.overrideCount = 0;
            return this;
        }
        const i = this.rig.index.get(bone);
        if (i !== undefined && this.overrides[i]) {
            this.overrides[i] = undefined;
            this.overrideCount--;
        }
        return this;
    }

    private setOverride(
        bone: string,
        o: Pick<Override, "mode" | "value" | "wx" | "wy" | "offset">,
        opts: BoneOverrideOptions,
    ): this {
        const i = this.rig.index.get(bone);
        if (i === undefined) {
            console.warn(`[skeletor] no bone called "${bone}"`);
            return this;
        }
        if (!this.overrides[i]) this.overrideCount++;
        this.overrides[i] = {
            ...o,
            weight: opts.weight ?? 1,
            limit: opts.limit,
        };
        return this;
    }

    // ------------------------------------------------------------------------------------------------ IK

    /** names of the IK constraints in the file (as named in the editor) */
    getIKNames(): string[] {
        return this.rig.ik.map((k) => k.name);
    }

    /**
     * Make an IK chain (a leg, an arm) reach a WORLD position. Call it every frame with the position you want, e.g. a
     * foot on the ground, a hand on a ladder, a hand on the aim point. The two bones follow it and the rest of the
     * skeleton moves with them; the playing animation still drives everything else.
     * `name` can be the IK's own name ("IK 3") or the name of its target object ("r-hand-target").
     * It switches the IK on (weight 1) unless you pass a weight, or already set one with setIKWeight.
     * Out of reach, the chain stretches straight towards the target.
     */
    setIKTarget(
        name: string,
        worldX: number,
        worldY: number,
        weight?: number,
    ): this {
        const k = this.ikState(name);
        if (!k) return this;
        k.tObj = null; // plain numbers take over from an object
        k.hasTarget = true;
        k.tx = worldX;
        k.ty = worldY;
        if (weight !== undefined) this.setIKWeight(name, weight);
        else if (k.weightTarget <= 0) this.setIKWeight(name, 1);
        return this;
    }

    /**
     * Which way the middle joint (knee / elbow) bends: towards this WORLD position. Without a pole it bends the way
     * it did in the editor, relative to the character, so it keeps bending forward when the character flips.
     */
    setIKPole(name: string, worldX: number, worldY: number): this {
        const k = this.ikState(name);
        if (!k) return this;
        k.pObj = null;
        k.hasPole = true;
        k.px = worldX;
        k.py = worldY;
        return this;
    }

    /** go back to the exported bend direction after setIKPole */
    clearIKPole(name: string): this {
        const k = this.ikState(name);
        if (k) {
            k.hasPole = false;
            k.pObj = null;
        }
        return this;
    }

    /** force the bend direction: 1 or -1 (-1 = the other way round than in the editor) */
    setIKBend(name: string, side: 1 | -1): this {
        const k = this.ikState(name);
        if (k) k.bend = side < 0 ? -1 : 1;
        return this;
    }

    /**
     * How much the IK wins over the animation, 0..1 (0 = off, the bones just play the animation).
     * With fadeSeconds it eases there, e.g. setIKWeight("leg", 0, 0.2) lets go of the ground smoothly.
     */
    setIKWeight(name: string, weight: number, fadeSeconds = 0): this {
        const k = this.ikState(name);
        if (!k) return this;
        k.weightTarget = clamp01(weight);
        if (fadeSeconds > 0) {
            k.weightRate = Math.abs(k.weightTarget - k.weight) / fadeSeconds;
        } else {
            k.weight = k.weightTarget;
            k.weightRate = 0;
        }
        return this;
    }

    /** switch one IK off right away (all of them without a name): the bones go back to the animation */
    clearIK(name?: string): this {
        const list = name === undefined ? this.iks : [this.ikState(name)];
        for (const k of list) {
            if (!k) continue;
            k.hasTarget = false;
            k.hasPole = false;
            k.tObj = null; // the Zones made by getIKTarget / getIKPole stay; asking for them again switches the IK back on
            k.pObj = null;
            k.weight = 0;
            k.weightTarget = 0;
            k.weightRate = 0;
        }
        return this;
    }

    /** is this IK doing something right now (it has a target and a weight above 0) */
    isIKActive(name: string): boolean {
        const k = this.ikState(name);
        return !!k && k.hasTarget && k.weight > 0;
    }

    /**
     * The object that controls an IK target, found by the NAME it has in the editor ("Left leg target"; the IK's own
     * name, "Left leg", works too). Move it, tween it, or attach it to a sprite / physics body (set its x / y, or
     * `hero.bindIKTarget(name, sprite)`): the chain reaches it every frame. Its x / y are WORLD coordinates.
     *
     * The first call makes an invisible Zone on the tip of the chain (so nothing jumps), switches the IK on and returns
     * it. If you bound your own object it returns that one.
     *   const foot = hero.getIKTarget("Left leg target");
     *   foot.setPosition(groundX, groundY);     // or this.tweens.add({ targets: foot, y: 300 }) ...
     * The IK reads the object when the skeleton updates (before your update()): call hero.step(0) after moving it if
     * you need the very same frame.
     */
    getIKTarget(name: string): IKFollower {
        const i = this.ikIndex(name, this.rig.targetByName);
        if (i === undefined) return this.detachedZone(); // unknown name: warned already; a loose object so your code keeps running
        const k = this.iks[i];
        if (!k.tObj) {
            if (!k.tZone) {
                const tip = this.getBoneWorld(
                    this.rig.bones[this.rig.ik[i].b].name,
                    this.tmpPose,
                )!;
                k.tZone = this.makeZone(tip.tipX, tip.tipY);
            }
            k.tObj = k.tZone;
        }
        k.hasTarget = true;
        this.readFollower(k.tObj, this.pt);
        k.tx = this.pt.x;
        k.ty = this.pt.y;
        if (k.weightTarget <= 0) this.setIKWeight(this.rig.ik[i].name, 1);
        return k.tObj!;
    }

    /**
     * The object that controls where the knee / elbow bends, found by its editor name ("Left leg pole"). The joint
     * bends towards it. It starts in front of the joint, on the side the editor had it. Same rules as getIKTarget.
     */
    getIKPole(name: string): IKFollower {
        const i = this.ikIndex(name, this.rig.poleByName);
        if (i === undefined) return this.detachedZone();
        const k = this.iks[i];
        if (!k.pObj) {
            if (!k.pZone) {
                const def = this.rig.ik[i];
                const a = this.getBone(
                    this.rig.bones[def.a].name,
                    this.tmpPose,
                )!;
                const rx = a.x;
                const ry = a.y;
                const b = this.getBone(
                    this.rig.bones[def.b].name,
                    this.tmpPose,
                )!;
                const dx = b.tipX - rx;
                const dy = b.tipY - ry;
                const len = Math.hypot(dx, dy) || 1;
                const side = k.bend;
                // in front of the joint along the bend side, in the skeleton's space; then into the world
                const lx = b.x + (side * -dy * 60) / len;
                const ly = b.y + (side * dx * 60) / len;
                const m = this.getWorldTransformMatrix(this.m3, this.m4);
                m.transformPoint(lx, ly, this.pt);
                k.pZone = this.makeZone(this.pt.x, this.pt.y);
            }
            k.pObj = k.pZone;
        }
        k.hasPole = true;
        this.readFollower(k.pObj, this.pt);
        k.px = this.pt.x;
        k.py = this.pt.y;
        return k.pObj!;
    }

    /** make your own object (a sprite, a physics body's sprite ...) the IK target; null lets go of it */
    bindIKTarget(name: string, obj: IKFollower | null): this {
        const i = this.ikIndex(name, this.rig.targetByName);
        if (i === undefined) return this;
        const k = this.iks[i];
        k.tObj = obj;
        if (obj) {
            k.hasTarget = true;
            if (k.weightTarget <= 0) this.setIKWeight(this.rig.ik[i].name, 1);
        }
        return this;
    }

    /** make your own object the IK pole; null lets go of it */
    bindIKPole(name: string, obj: IKFollower | null): this {
        const i = this.ikIndex(name, this.rig.poleByName);
        if (i === undefined) return this;
        const k = this.iks[i];
        k.pObj = obj;
        k.hasPole = !!obj;
        return this;
    }

    /** names of the target objects, as named in the editor */
    getIKTargetNames(): string[] {
        return this.rig.ik.map((k) => k.target);
    }

    /** names of the pole objects, as named in the editor */
    getIKPoleNames(): string[] {
        return this.rig.ik.map((k) => k.pole);
    }

    private tmpPose: BonePose = { x: 0, y: 0, rotation: 0, tipX: 0, tipY: 0 };

    /** a throw-away object for a name that doesn't exist, so `getIKTarget("typo").setPosition(...)` doesn't crash */
    private detachedZone(): GameObjects.Zone {
        return new GameObjects.Zone(this.scene, 0, 0, 1, 1);
    }

    private makeZone(x: number, y: number): GameObjects.Zone {
        const z = new GameObjects.Zone(this.scene, x, y, 1, 1);
        this.scene.add.existing(z);
        return z;
    }

    /** world position of a follower (handles being inside a Container) */
    private readFollower(o: IKFollower, out: { x: number; y: number }) {
        if (o.parentContainer) {
            const m = o.getWorldTransformMatrix(this.m3, this.m4);
            out.x = m.tx;
            out.y = m.ty;
        } else {
            out.x = o.x;
            out.y = o.y;
        }
    }

    /** pull the followed objects' positions into the IK states (a destroyed object lets go) */
    private readFollowers() {
        for (const k of this.iks) {
            if (k.tObj) {
                if (!k.tObj.scene) k.tObj = null;
                else {
                    this.readFollower(k.tObj, this.pt);
                    k.tx = this.pt.x;
                    k.ty = this.pt.y;
                }
            }
            if (k.pObj) {
                if (!k.pObj.scene) {
                    k.pObj = null;
                    k.hasPole = false;
                } else {
                    this.readFollower(k.pObj, this.pt);
                    k.px = this.pt.x;
                    k.py = this.pt.y;
                }
            }
        }
    }

    /** an IK by the name of the IK, or by the name of its target / pole object */
    private ikIndex(
        name: string,
        byObjectName: Map<string, number>,
    ): number | undefined {
        const i = byObjectName.get(name) ?? this.rig.ikByName.get(name);
        if (i === undefined) {
            console.warn(
                `[skeletor] nothing called "${name}" (IK: ${this.getIKNames().join(", ") || "none"}; ` +
                    `targets: ${this.getIKTargetNames().join(", ") || "none"}; poles: ${this.getIKPoleNames().join(", ") || "none"})`,
            );
        }
        return i;
    }

    /**
     * An IK by its own name ("IK 3"), by the name of its target object ("r-hand-target") or by the name of its pole
     * object ("IK 3 pole"). Every IK method that takes a `name` goes through here.
     */
    private ikState(name: string): IKState | undefined {
        const i =
            this.rig.ikByName.get(name) ??
            this.rig.targetByName.get(name) ??
            this.rig.poleByName.get(name);
        if (i === undefined) {
            console.warn(
                `[skeletor] nothing called "${name}" (IK: ${this.getIKNames().join(", ") || "none"}; ` +
                    `targets: ${this.getIKTargetNames().join(", ") || "none"}; poles: ${this.getIKPoleNames().join(", ") || "none"})`,
            );
            return undefined;
        }
        return this.iks[i];
    }

    // ------------------------------------------------------------------------------------------------ planting feet on uneven ground

    /**
     * Keep a leg (an IK from the editor) on the ground while the animation plays. Call it ONCE; after that it runs
     * every frame by itself. Each frame it asks where the animation alone would put the foot, asks YOUR raycast where
     * the ground is under it, and moves the foot to the ground while it is planted, and lets the animation lift it when
     * it is swinging. So running up a slope or over a step keeps the feet on the floor and the animation intact.
     *
     *   hero.plantBone("Left leg", { ground: (x, y) => this.groundYAt(x, y, this.body), bone: "Foot_L" });
     *   hero.plantBone("Right leg", { ground: (x, y) => this.groundYAt(x, y, this.body), bone: "Foot_R" });
     *
     * `name` is the IK (or its target's name) from the editor. It takes over that IK: don't also call
     * setIKTarget / getIKTarget on it. unplantBone(name) gives it back.
     */
    plantBone(name: string, opts: PlantOptions): this {
        const i = this.ikIndex(name, this.rig.targetByName);
        if (i === undefined) return this;
        const def = this.rig.ik[i];
        let sample = def.b;
        if (opts.bone !== undefined) {
            const bi = this.rig.index.get(opts.bone);
            if (bi === undefined) {
                console.warn(
                    `[skeletor] plantBone: no bone called "${opts.bone}" (the file has: ${this.rig.bones.map((b) => b.name).join(", ")})`,
                );
                return this;
            }
            sample = bi;
        }
        const k = this.iks[i];
        const existing = this.plants.find((p) => p.ik === i);
        if (existing) {
            existing.sample = sample;
            existing.opts = opts;
            existing.info.bone = this.rig.bones[sample].name;
        } else {
            this.plants.push({
                ik: i,
                sample,
                opts,
                info: {
                    ik: def.name,
                    bone: this.rig.bones[sample].name,
                    hit: false,
                    groundY: null,
                    footX: 0,
                    footY: 0,
                    chainX: 0,
                    chainY: 0,
                    targetX: 0,
                    targetY: 0,
                    level: 0,
                    lift: 0,
                    shift: 0,
                    clamped: false,
                    planted: 0,
                    weight: 0,
                },
            });
            k.tObj = null; // numbers from the plant take over from any object
            k.hasTarget = true;
        }
        return this;
    }

    /** stop planting this leg: the IK goes back to what the animation does (fades over `fadeSeconds`) */
    unplantBone(name: string, fadeSeconds = 0.1): this {
        const i = this.ikIndex(name, this.rig.targetByName);
        if (i === undefined) return this;
        const at = this.plants.findIndex((p) => p.ik === i);
        if (at >= 0) {
            this.plants.splice(at, 1);
            this.setIKWeight(this.rig.ik[i].name, 0, fadeSeconds);
        }
        return this;
    }

    /** runs inside step(): the plants decide their targets and weights for this frame */
    private updatePlants(dt: number) {
        if (!this.plants.length) {
            this.plantGfx?.clear();
            return;
        }
        this.plantGfx?.clear();

        // where does the animation alone put everything (no IK)? one pass for all plants
        this.ikOff = true;
        this.applyPose();
        this.ikOff = false;

        const sample = this.tmpPose;
        for (const p of this.plants) {
            const def = this.rig.ik[p.ik];
            const k = this.iks[p.ik];
            const o = p.opts;
            const sb = this.rig.bones[p.sample];
            const tip = this.plantTip;

            this.getBoneWorld(sb.name, sample);
            const sx = sample.tipX;
            const sy = sample.tipY;
            // the chain's own tip (the lower IK bone), where the IK has to put it
            this.getBoneWorld(this.rig.bones[def.b].name, sample);
            tip.x = sample.tipX;
            tip.y = sample.tipY;

            const level =
                typeof o.groundLevel === "function"
                    ? o.groundLevel()
                    : (o.groundLevel ?? this.y);
            const gy = o.ground(sx, sy);
            let planted = 0;
            let shift = 0;
            let clamped = false;
            const hit = gy !== null && gy !== undefined && Number.isFinite(gy);
            if (hit) {
                const lift = level - sy; // how high the animation holds the foot above the flat ground
                const height = Math.max(o.plantHeight ?? 48, 1e-3);
                planted = clamp01(1 - lift / height);
                const max = Math.abs(o.maxShift ?? 100);
                const want = gy - level - (o.offset ?? 0);
                shift = Math.max(-max, Math.min(max, want));
                clamped = shift !== want;
            }

            k.tObj = null;
            k.hasTarget = true;
            k.tx = tip.x;
            k.ty = tip.y + shift;
            const smooth = o.smooth ?? 0.05;
            k.weightTarget = planted;
            if (smooth > 0 && dt > 0) {
                // ease towards it (never slower than `smooth` seconds for the whole way)
                const d = dt / smooth;
                k.weight += (planted - k.weight) * Math.min(1, d);
                if (Math.abs(planted - k.weight) < 1e-3) k.weight = planted;
            } else k.weight = planted;
            k.weightRate = 0;

            const inf = p.info;
            inf.hit = hit;
            inf.groundY = hit ? (gy as number) : null;
            inf.footX = sx;
            inf.footY = sy;
            inf.chainX = tip.x;
            inf.chainY = tip.y;
            inf.targetX = k.tx;
            inf.targetY = k.ty;
            inf.level = level;
            inf.lift = level - sy;
            inf.shift = shift;
            inf.clamped = clamped;
            inf.planted = planted;
            inf.weight = k.weight;
            if (this.plantGfx) this.drawPlant(this.plantGfx, inf);
        }
    }

    /**
     * What plantBone decided on the last update (see PlantInfo): the foot position, where the ground check hit, where
     * the leg is sent, how planted it is ... Handy to log or draw. It is a live object that updates every frame.
     *   const info = hero.getPlantInfo("IK 1");   console.log(info?.hit, info?.groundY, info?.planted);
     * null if that leg isn't planted (plantBone not called for it).
     */
    getPlantInfo(name: string): Readonly<PlantInfo> | null {
        const i =
            this.rig.ikByName.get(name) ?? this.rig.targetByName.get(name);
        if (i === undefined) return null;
        return this.plants.find((p) => p.ik === i)?.info ?? null;
    }

    /**
     * Draw the planting on screen (world space) so you can see what it does. Call it once with true; false removes it.
     *   white dot  = the foot tip your ground check was asked about
     *   yellow line= the ray down to the ground, green dot = hit and planted, orange dot = hit but the foot is in the air
     *   red ring   = no ground found
     *   cyan dot   = where the leg is sent, with a line from the chain tip
     */
    setPlantDebug(on = true): this {
        if (on && !this.plantGfx) {
            this.plantGfx = this.scene.add.graphics();
            this.plantGfx.setDepth(100000);
        } else if (!on && this.plantGfx) {
            this.plantGfx.destroy();
            this.plantGfx = null;
        }
        return this;
    }

    private plantGfx: GameObjects.Graphics | null = null;

    private drawPlant(g: GameObjects.Graphics, i: PlantInfo) {
        if (i.hit && i.groundY !== null) {
            g.lineStyle(1, 0xffff00, 0.9);
            g.lineBetween(i.footX, i.footY, i.footX, i.groundY);
            g.fillStyle(i.planted > 0.5 ? 0x00ff88 : 0xff9900, 1);
            g.fillCircle(i.footX, i.groundY, 5);
        } else {
            g.lineStyle(2, 0xff3b3b, 1);
            g.strokeCircle(i.footX, i.footY, 9);
        }
        g.fillStyle(0xffffff, 1);
        g.fillCircle(i.footX, i.footY, 3);
        g.lineStyle(1, 0x00e5ff, 0.8);
        g.lineBetween(i.chainX, i.chainY, i.targetX, i.targetY);
        g.fillStyle(0x00e5ff, 1);
        g.fillCircle(i.targetX, i.targetY, 4);
    }

    private plantTip = { x: 0, y: 0 };

    // ------------------------------------------------------------------------------------------------ parts, skins, attachments

    /**
     * Let the scene's lights shine on the character (sprite parts only; plain rectangles are not lit).
     *   this.lights.enable().setAmbientColor(0x303030); this.lights.addLight(400, 300, 300);
     *   hero.setLit(true);
     * Works with Phaser 4 (setLighting) and Phaser 3 (the Light2D pipeline). Pass false to turn it off.
     * Sprites you attach with attachToBone are yours: light them yourself.
     */
    setLit(on = true): this {
        this.lit = on;
        for (const obj of this.partObjects) {
            if (!(obj instanceof GameObjects.Image)) continue;
            const o = obj as unknown as {
                setLighting?: (v: boolean) => unknown;
                setPipeline?: (v: string) => unknown;
                resetPipeline?: () => unknown;
            };
            if (typeof o.setLighting === "function") o.setLighting(on);
            else if (on && typeof o.setPipeline === "function")
                o.setPipeline("Light2D");
            else if (!on && typeof o.resetPipeline === "function")
                o.resetPipeline();
        }
        return this;
    }

    /** are the sprite parts lit by the scene's lights */
    get isLit(): boolean {
        return this.lit;
    }

    /** names of the parts (rectangles / sprites) in draw order, back to front */
    getPartNames(): string[] {
        return this.rig.data.parts.map((p) => p.name);
    }

    /** the game object drawing a part, by its name in the editor (null if there is none) */
    getPart(name: string): GameObjects.Image | GameObjects.Rectangle | null {
        const i = this.partIndexByName.get(name);
        if (i === undefined) {
            console.warn(
                `[skeletor] no part called "${name}" (the file has: ${this.getPartNames().join(", ")})`,
            );
            return null;
        }
        return this.partObjects[i];
    }

    /**
     * Show a different picture on a sprite part (a skin, a different outfit). Load the image first.
     * It is drawn at the part's size from the editor, so give it the same proportions.
     *   hero.setPartImage("Body", "body_red.png");
     */
    setPartImage(part: string, textureKey: string): this {
        const i = this.partIndexByName.get(part);
        if (i === undefined) {
            console.warn(
                `[skeletor] no part called "${part}" (the file has: ${this.getPartNames().join(", ")})`,
            );
            return this;
        }
        const obj = this.partObjects[i];
        if (!(obj instanceof GameObjects.Image)) {
            console.warn(
                `[skeletor] "${part}" is not a loaded sprite, so its picture can't be swapped`,
            );
            return this;
        }
        if (!this.scene.textures.exists(textureKey)) {
            console.warn(
                `[skeletor] image "${textureKey}" is not loaded (this.load.image("${textureKey}", ...) in preload)`,
            );
            return this;
        }
        const p = this.rig.data.parts[i];
        obj.setTexture(textureKey).setDisplaySize(p.width, p.height);
        return this;
    }

    /**
     * Swap several sprite parts at once: setSkin({ Body: "body_red.png", Arm: "arm_red.png" }).
     * Parts you don't list go back to the images from the editor; setSkin(null) puts them all back.
     */
    setSkin(images: Record<string, string> | null): this {
        const parts = this.rig.data.parts;
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (p.type !== "sprite" || !p.image) continue;
            const want = images?.[p.name] ?? p.image;
            const obj = this.partObjects[i];
            if (
                obj instanceof GameObjects.Image &&
                this.scene.textures.exists(want) &&
                obj.texture.key !== want
            )
                obj.setTexture(want).setDisplaySize(p.width, p.height);
        }
        if (images)
            for (const name of Object.keys(images))
                if (!this.partIndexByName.has(name))
                    console.warn(
                        `[skeletor] setSkin: no part called "${name}" (the file has: ${this.getPartNames().join(", ")})`,
                    );
        return this;
    }

    /**
     * Glue any game object (a gun, a hat, another Skeleton) to a bone. It becomes a child of this skeleton, so it
     * flips, scales and moves with the character, and follows the bone every frame.
     * `below` / `above` put it in the character's draw order next to a part:
     *   hero.attachToBone(gun, "hand_R", { below: "Hand R" });   // over the body, under the right hand
     *   hero.attachToBone(gun, "hand_R", { at: "tip" });          // glued to the END of the bone (the fingertips)
     * With neither, it is drawn on top of everything. Attach again to move it; detach() lets go.
     */
    attachToBone(
        obj: Attachment["obj"],
        bone: string,
        opts: AttachOptions = {},
    ): this {
        const bi = this.rig.index.get(bone);
        if (bi === undefined) {
            console.warn(`[skeletor] no bone called "${bone}" (attachToBone)`);
            return this;
        }
        this.detach(obj, false);
        this.add(obj); // also takes it out of wherever it was
        const ref = opts.below ?? opts.above;
        if (ref !== undefined) {
            const refObj = this.getPart(ref);
            if (refObj) {
                const at = this.getIndex(refObj) + (opts.below ? 0 : 1);
                this.moveTo(obj, at);
            }
        }
        this.attachments.push({
            obj,
            bone: bi,
            along:
                opts.at === "tip"
                    ? 1
                    : typeof opts.at === "number"
                      ? opts.at
                      : 0,
            x: opts.x ?? 0,
            y: opts.y ?? 0,
            rotation: opts.rotation ?? 0,
            followRotation: opts.followRotation ?? true,
        });
        this.placeAttachments();
        return this;
    }

    /**
     * Point an attached object (a gun) at a WORLD position, correctly whether the character faces left or right.
     * Attach it with `followRotation: false`, then call this every frame:
     *   hero.attachToBone(gun, "hand_R", { below: "Hand R", followRotation: false });
     *   hero.aimAttached(gun, pointer.worldX, pointer.worldY);
     * `offset` (radians) is for art that doesn't point to the right at rotation 0.
     * Don't use gun.setRotation(angleInTheWorld): inside a flipped skeleton that angle is mirrored.
     */
    aimAttached(
        obj: Attachment["obj"],
        worldX: number,
        worldY: number,
        offset = 0,
    ): this {
        const m = this.getWorldTransformMatrix(this.m3, this.m4);
        m.applyInverse(worldX, worldY, this.pt);
        if (Number.isFinite(this.pt.x) && Number.isFinite(this.pt.y))
            obj.setRotation(
                Math.atan2(this.pt.y - obj.y, this.pt.x - obj.x) + offset,
            );
        return this;
    }

    /** let go of an attached object (it stays a child of this skeleton unless you pass remove = true) */
    detach(obj: Attachment["obj"], remove = true): this {
        const i = this.attachments.findIndex((a) => a.obj === obj);
        if (i >= 0) {
            this.attachments.splice(i, 1);
            if (remove) this.remove(obj);
        }
        return this;
    }

    /** put attached objects on their bones (skeleton space) */
    private placeAttachments() {
        const list = this.attachments;
        for (let k = list.length - 1; k >= 0; k--) {
            const a = list[k];
            if (!a.obj.scene) {
                list.splice(k, 1); // destroyed
                continue;
            }
            const c = this.wc[a.bone];
            const s = this.ws[a.bone];
            const d = a.along * this.rig.bones[a.bone].length;
            a.obj.setPosition(
                this.wx[a.bone] + (d + a.x) * c - a.y * s,
                this.wy[a.bone] + (d + a.x) * s + a.y * c,
            );
            if (a.followRotation)
                a.obj.setRotation(this.wr[a.bone] + a.rotation);
        }
    }

    // ------------------------------------------------------------------------------------------------ reading bones

    /** is there a bone with this name */
    hasBone(name: string): boolean {
        return this.rig.index.has(name);
    }

    /**
     * A bone in world space as the ANIMATION alone puts it: no IK. For foot placement: ask where the animated foot
     * would be, find the ground there, then aim the IK at the ground. (It poses the skeleton twice, so use it for a few
     * bones per frame, not all of them.)
     */
    getAnimatedBoneWorld(
        name: string,
        out: BonePose = { x: 0, y: 0, rotation: 0, tipX: 0, tipY: 0 },
    ): BonePose | null {
        if (!this.rig.index.has(name)) return null;
        this.ikOff = true;
        this.applyPose();
        const r = this.getBoneWorld(name, out);
        this.ikOff = false;
        this.applyPose();
        return r;
    }

    /** a bone in the skeleton's own space (as of the last update) */
    getBone(
        name: string,
        out: BonePose = { x: 0, y: 0, rotation: 0, tipX: 0, tipY: 0 },
    ): BonePose | null {
        const i = this.rig.index.get(name);
        if (i === undefined) return null;
        const len = this.rig.bones[i].length;
        out.x = this.wx[i];
        out.y = this.wy[i];
        out.rotation = this.wr[i];
        out.tipX = this.wx[i] + this.wc[i] * len;
        out.tipY = this.wy[i] + this.ws[i] * len;
        return out;
    }

    /** a bone in world space (follows this object's position, flip, scale and rotation): handy for muzzles, hands, effects */
    getBoneWorld(
        name: string,
        out: BonePose = { x: 0, y: 0, rotation: 0, tipX: 0, tipY: 0 },
    ): BonePose | null {
        const i = this.rig.index.get(name);
        if (i === undefined) return null;
        const len = this.rig.bones[i].length;
        const m = this.getWorldTransformMatrix(this.m1, this.m2);
        const x = this.wx[i];
        const y = this.wy[i];
        m.transformPoint(x, y, this.pt);
        out.x = this.pt.x;
        out.y = this.pt.y;
        m.transformPoint(x + this.wc[i] * len, y + this.ws[i] * len, this.pt);
        out.tipX = this.pt.x;
        out.tipY = this.pt.y;
        m.transformPoint(x + this.wc[i], y + this.ws[i], this.pt);
        out.rotation = Math.atan2(this.pt.y - out.y, this.pt.x - out.x);
        return out;
    }

    // ------------------------------------------------------------------------------------------------ update

    /** Phaser calls this every frame (the factory puts the object on the update list) */
    preUpdate(_time: number, delta: number) {
        this.step(delta / 1000);
    }

    /** advance by `dt` seconds and redraw (preUpdate does this for you; call it yourself to drive time manually) */
    step(dt: number) {
        if (!this.isPaused && dt > 0) {
            dt *= this.playbackSpeed;

            for (const k of this.iks) {
                if (k.weight === k.weightTarget) continue;
                const d = k.weightRate * dt;
                k.weight =
                    k.weight < k.weightTarget
                        ? Math.min(k.weightTarget, k.weight + d)
                        : Math.max(k.weightTarget, k.weight - d);
            }

            // blended animations share one phase, advanced at the weighted average length
            let wsum = 0;
            let dsum = 0;
            for (const l of this.layers) {
                if (l.synced && l.weight > 0 && l.dur > 0) {
                    wsum += l.weight;
                    dsum += l.weight * l.dur;
                }
            }
            if (wsum > 0)
                this.phase =
                    (this.phase + (dt * this.blendSpeed) / (dsum / wsum)) % 1;

            for (let i = this.layers.length - 1; i >= 0; i--) {
                const l = this.layers[i];
                if (l.weight !== l.target) {
                    const d = l.rate * dt;
                    l.weight =
                        l.weight < l.target
                            ? Math.min(l.target, l.weight + d)
                            : Math.max(l.target, l.weight - d);
                }
                if (l.synced) {
                    l.time = this.phase * l.dur;
                } else {
                    const prev = l.time;
                    l.time += dt * l.speed;
                    if (l.dur > 0 && l.target > 0) {
                        if (l.loop) {
                            if (
                                Math.floor(l.time / l.dur) >
                                Math.floor(prev / l.dur)
                            )
                                this.pending.push([
                                    SkeletonEvents.LOOP,
                                    l.name,
                                ]);
                        } else if (!l.done && l.time >= l.dur) {
                            l.done = true;
                            this.pending.push([
                                SkeletonEvents.COMPLETE,
                                l.name,
                            ]);
                        }
                    }
                }
                if (l.target === 0 && l.weight === 0) this.layers.splice(i, 1);
            }

            // layers on top of the base animation
            for (let i = this.overlays.length - 1; i >= 0; i--) {
                const o = this.overlays[i];
                if (o.weight !== o.target) {
                    const d = o.rate * dt;
                    o.weight =
                        o.weight < o.target
                            ? Math.min(o.target, o.weight + d)
                            : Math.max(o.target, o.weight - d);
                }
                if (o.replacedBy) {
                    const r = o.replacedBy;
                    const gone = !this.overlays.includes(r) || r.target === 0;
                    if (gone || r.weight >= r.strength - 1e-9) {
                        o.replacedBy = null;
                        o.target = 0;
                        o.rate = o.weight / Math.max(o.fadeOut, 1e-4);
                    }
                }
                const prev = o.time;
                o.time += dt * o.speed;
                if (o.dur > 0) {
                    if (o.loop) {
                        if (
                            !o.leaving &&
                            Math.floor(o.time / o.dur) >
                                Math.floor(prev / o.dur)
                        )
                            this.pending.push([
                                SkeletonEvents.LOOP,
                                o.name,
                                o.slot,
                            ]);
                    } else {
                        // start fading out early enough to be gone when the animation ends
                        if (
                            !o.leaving &&
                            !o.ending &&
                            o.time >= o.dur - o.fadeOut
                        ) {
                            o.ending = true;
                            o.target = 0;
                            const left =
                                Math.max(o.dur - o.time, 0) || o.fadeOut;
                            o.rate = o.weight / Math.max(left, 1e-4);
                        }
                        if (!o.done && !o.leaving && o.time >= o.dur) {
                            o.done = true;
                            this.pending.push([
                                SkeletonEvents.COMPLETE,
                                o.name,
                                o.slot,
                            ]);
                        }
                    }
                }
                if (o.target === 0 && o.weight === 0)
                    this.overlays.splice(i, 1);
            }
        }

        this.updatePlants(this.isPaused ? 0 : dt);
        this.applyPose();

        // events last, so a handler can call play() without upsetting the loop above
        if (this.pending.length) {
            for (const [event, name, slot] of this.pending.splice(0))
                this.emit(event, name, slot);
        }
    }

    /** solve every bone and put every part where it belongs */
    private applyPose() {
        const rig = this.rig;
        const bones = rig.bones;
        const parentOf = rig.parent;
        const { wx, wy, wr, wc, ws } = this;
        const layers = this.layers;
        const overrides = this.overrides;
        const useOverrides = this.overrideCount > 0;
        let world: GameObjects.Components.TransformMatrix | null = null;

        for (const l of layers) l.frame = frameOf(l);
        const overlays = this.overlays;
        for (const o of overlays) o.frame = frameOf(o);
        const iks = this.iks;
        this.readFollowers();
        for (const k of iks) k.solved = false;

        for (let i = 0; i < bones.length; i++) {
            const b = bones[i];

            // blend every animation's offsets (a bone an animation doesn't touch counts as "no offset")
            let dr = 0;
            let dx = 0;
            let dy = 0;
            let wsum = 0;
            for (let k = 0; k < layers.length; k++) {
                const l = layers[k];
                const w = l.weight;
                if (w <= 0) continue;
                let r = 0;
                let x = 0;
                let y = 0;
                const keys = l.tracks[i];
                if (keys) {
                    sampleInto(keys, l.frame);
                    r = S.r;
                    x = S.x;
                    y = S.y;
                }
                wsum += w;
                if (wsum === w) {
                    dr = r;
                    dx = x;
                    dy = y;
                } else {
                    const t = w / wsum;
                    dr = lerpAngle(dr, r, t);
                    dx += (x - dx) * t;
                    dy += (y - dy) * t;
                }
            }

            // animations layered on top, on their bones only
            for (let k = 0; k < overlays.length; k++) {
                const o = overlays[k];
                const m = o.mask[i];
                if (m === 0 || o.weight <= 0) continue;
                const keys = o.tracks[i];
                if (!keys && o.keyedOnly) continue;
                let r = 0;
                let x = 0;
                let y = 0;
                if (keys) {
                    sampleInto(keys, o.frame);
                    r = S.r;
                    x = S.x;
                    y = S.y;
                }
                const w = o.weight * m;
                if (o.mode === "add") {
                    dr += r * w;
                    dx += x * w;
                    dy += y * w;
                } else {
                    dr = lerpAngle(dr, r, w);
                    dx += (x - dx) * w;
                    dy += (y - dy) * w;
                }
            }

            // a bone of an active IK sits where its setup says (like in the editor, IK bones take no position offsets)
            const ia = rig.ikA[i];
            const ib = rig.ikB[i];
            const ikUpper =
                !this.ikOff &&
                ia >= 0 &&
                iks[ia].hasTarget &&
                iks[ia].weight > 0;
            const ikLower = ib >= 0 && iks[ib].solved;
            const lx = ikUpper || ikLower ? b.x : b.x + dx;
            const ly = ikUpper || ikLower ? b.y : b.y + dy;
            let lr = b.rotation + dr;

            // world position of the pivot, from the parent
            const pi = parentOf[i];
            let x = lx;
            let y = ly;
            let pr = 0;
            if (pi >= 0) {
                const c = wc[pi];
                const s = ws[pi];
                x = wx[pi] + lx * c - ly * s;
                y = wy[pi] + lx * s + ly * c;
                pr = wr[pi];
            }

            // procedural override of the rotation
            const o = useOverrides ? overrides[i] : undefined;
            if (o && o.weight > 0) {
                let target = lr;
                let ok = true;
                if (o.mode === "add") target = lr + o.value;
                else if (o.mode === "local") target = o.value;
                else if (o.mode === "world") target = o.value - pr;
                else {
                    // aim: the target in the skeleton's space, so flipping / moving / scaling the object just works
                    world ??= this.getWorldTransformMatrix(this.m1, this.m2);
                    world.applyInverse(o.wx, o.wy, this.pt);
                    if (
                        Number.isFinite(this.pt.x) &&
                        Number.isFinite(this.pt.y)
                    ) {
                        target =
                            Math.atan2(this.pt.y - y, this.pt.x - x) +
                            o.offset -
                            pr;
                    } else {
                        ok = false; // mid-turn the object is flat (scale 0), there is no direction to aim in
                    }
                }
                if (ok) {
                    if (o.limit !== undefined) {
                        const d = wrapAngle(target - b.rotation);
                        target =
                            b.rotation +
                            Math.max(-o.limit, Math.min(o.limit, d));
                    }
                    lr = lerpAngle(lr, target, Math.min(1, o.weight));
                }
            }

            // IK: the upper bone solves the whole chain (target in the skeleton's space), the lower bone reads the result
            if (ikUpper) {
                const k = iks[ia];
                world ??= this.getWorldTransformMatrix(this.m1, this.m2);
                world.applyInverse(k.tx, k.ty, this.pt);
                const tx = this.pt.x;
                const ty = this.pt.y;
                if (Number.isFinite(tx) && Number.isFinite(ty)) {
                    let side = k.bend;
                    if (k.hasPole) {
                        world.applyInverse(k.px, k.py, this.pt);
                        if (
                            Number.isFinite(this.pt.x) &&
                            Number.isFinite(this.pt.y)
                        )
                            side =
                                (tx - x) * (this.pt.y - y) -
                                    (ty - y) * (this.pt.x - x) >=
                                0
                                    ? 1
                                    : -1;
                    }
                    if (
                        solveTwoBone(
                            x,
                            y,
                            b.length,
                            bones[rig.ik[ia].b].length,
                            tx,
                            ty,
                            side,
                        )
                    ) {
                        k.solved = true;
                        k.angleA = IK.a;
                        k.angleB = IK.b;
                        lr = lerpAngle(lr, IK.a - pr, k.weight);
                    }
                }
            } else if (ikLower) {
                lr = lerpAngle(lr, iks[ib].angleB - pr, iks[ib].weight);
            }

            const rot = pr + lr;
            wx[i] = x;
            wy[i] = y;
            wr[i] = rot;
            wc[i] = Math.cos(rot);
            ws[i] = Math.sin(rot);
        }

        // parts
        const parts = rig.data.parts;
        for (let k = 0; k < parts.length; k++) {
            const p = parts[k];
            const obj = this.partObjects[k];
            const bi = rig.partBone[k];
            if (bi < 0) {
                obj.setPosition(p.x, p.y).setRotation(p.rotation);
            } else {
                const c = wc[bi];
                const s = ws[bi];
                obj.setPosition(
                    wx[bi] + p.x * c - p.y * s,
                    wy[bi] + p.x * s + p.y * c,
                ).setRotation(wr[bi] + p.rotation);
            }
        }
        if (this.attachments.length) this.placeAttachments();
    }

    destroy(fromScene?: boolean) {
        this.turnTween?.stop();
        this.turnTween = null;
        this.layers.length = 0;
        this.overlays.length = 0;
        this.attachments.length = 0;
        this.plants.length = 0;
        this.plantGfx?.destroy();
        this.plantGfx = null;
        for (const k of this.iks) {
            k.tZone?.destroy();
            k.pZone?.destroy();
            k.tObj = k.pObj = k.tZone = k.pZone = null;
        }
        super.destroy(fromScene);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// plugin: this.add.skeleton() and this.load.skeleton()
// ---------------------------------------------------------------------------------------------------------------------

let registered = false;

/** adds this.add.skeleton(...) and this.load.skeleton(...). Importing this file already does it. */
export function registerSkeletor() {
    if (registered) return;
    registered = true;

    GameObjects.GameObjectFactory.register(
        "skeleton",
        function (
            this: GameObjects.GameObjectFactory,
            x: number,
            y: number,
            source: string | ExportData,
            options?: string | SkeletonOptions,
        ) {
            return this.existing(
                new Skeleton(this.scene, x, y, source, options),
            );
        },
    );

    // load.skeleton(key, "path/hero.json", imageFolder?): loads the json, then every image it uses.
    // The images are looked up next to the json unless you give a folder, and are named exactly as in the file.
    Loader.FileTypesManager.register(
        "skeleton",
        function (
            this: Loader.LoaderPlugin,
            key: string,
            url: string,
            imageFolder?: string,
        ) {
            const folder =
                imageFolder ?? url.slice(0, url.lastIndexOf("/") + 1);
            this.json(key, url);
            this.once(
                `filecomplete-json-${key}`,
                (_key: string, _type: string, data: ExportData) => {
                    for (const name of imageNames(data)) {
                        if (!this.textureManager.exists(name))
                            this.image(name, folder + name);
                    }
                },
            );
            return this;
        },
    );
}

registerSkeletor();

/**
 * Optional: install through the game config instead of (or as well as) importing the file.
 *   new Phaser.Game({ plugins: { global: [{ key: "Skeletor", plugin: SkeletorPlugin, start: true }] } })
 */
export class SkeletorPlugin extends Plugins.BasePlugin {
    constructor(pluginManager: Plugins.PluginManager) {
        super(pluginManager);
        registerSkeletor();
    }
}

declare global {
    namespace Phaser {
        namespace GameObjects {
            interface GameObjectFactory {
                /** a skeleton exported from the animation editor (load it first with this.load.skeleton) */
                skeleton(
                    x: number,
                    y: number,
                    source: string | ExportData,
                    options?: string | SkeletonOptions,
                ): Skeleton;
            }
        }
        namespace Loader {
            interface LoaderPlugin {
                /** load an exported animation json and every image it uses */
                skeleton(
                    key: string,
                    url: string,
                    imageFolder?: string,
                ): LoaderPlugin;
            }
        }
    }
}
