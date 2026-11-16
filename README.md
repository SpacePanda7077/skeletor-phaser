# Skeletor for Phaser

A runtime for playing skeletal animations exported from the Skeletor editor inside a Phaser game. It loads the exported JSON, builds the character from its sprite parts, and gives you animation playback, crossfading and blending, layered animations, procedural bone control, two-bone IK, foot planting, attachments, skins and lighting.

- Single-file runtime (`skeletor-phaser.ts`) plus the format types (`format.ts`)
- Allocation-free per frame
- Same maths as the editor, so what you see in the editor is what you get in game
- Adds `this.load.skeleton()` and `this.add.skeleton()` to Phaser

---

## Contents

1. [Installation](#1-installation)
2. [Quick start](#2-quick-start)
3. [Core concepts](#3-core-concepts)
4. [Loading and creating](#4-loading-and-creating)
5. [Animation playback](#5-animation-playback)
6. [Animation layers](#6-animation-layers)
7. [Facing](#7-facing)
8. [Bone overrides](#8-bone-overrides)
9. [Inverse kinematics](#9-inverse-kinematics)
10. [Foot planting](#10-foot-planting)
11. [Parts, skins and lighting](#11-parts-skins-and-lighting)
12. [Attachments](#12-attachments)
13. [Reading bones](#13-reading-bones)
14. [Events](#14-events)
15. [Update order and timing](#15-update-order-and-timing)
16. [Recipes](#16-recipes)
17. [Troubleshooting](#17-troubleshooting)
18. [Export format reference](#18-export-format-reference)
19. [Limitations](#19-limitations)

---

## 1. Installation

Copy two files into your project:

```
skeletor-phaser.ts
format.ts
```

`skeletor-phaser.ts` imports only types from `./format`. Then import the plugin once, anywhere before you create a skeleton:

```ts
import "./skeletor-phaser";
```

Importing the file registers `this.add.skeleton()` and `this.load.skeleton()`.

### Registering through the game config (optional)

Instead of, or as well as, importing the file, you can install it as a global plugin:

```ts
import { SkeletorPlugin } from "./skeletor-phaser";

new Phaser.Game({
    plugins: {
        global: [{ key: "Skeletor", plugin: SkeletorPlugin, start: true }],
    },
});
```

### Requirements

- Phaser 3 or Phaser 4 (lighting support covers both; see [Lighting](#lighting))
- TypeScript is recommended. The file augments `Phaser.GameObjects.GameObjectFactory` and `Phaser.Loader.LoaderPlugin` so `add.skeleton` and `load.skeleton` are typed.

---

## 2. Quick start

```ts
import "./skeletor-phaser";

class GameScene extends Phaser.Scene {
    hero!: Skeleton;

    preload() {
        // loads the JSON and every image it references (looked up next to the JSON)
        this.load.skeleton("hero", "assets/hero/hero.json");
    }

    create() {
        // (400, 500) is where the rig's origin, its feet, ends up
        this.hero = this.add.skeleton(400, 500, "hero", "idle");
    }

    update() {
        const pointer = this.input.activePointer;
        const moving = /* your input */ false;

        this.hero.faceTowards(pointer.worldX, 0.12);                  // flip left / right
        this.hero.play(moving ? "run" : "idle", { fade: 0.15 });      // safe to call every frame
        this.hero.aimBone("arm_R", pointer.worldX, pointer.worldY);   // procedural aim on top of the animation
        this.hero.setIKTarget("IK 1", groundX, groundY);              // a leg reaches a world point
    }
}
```

`Skeleton` is exported from `skeletor-phaser.ts`:

```ts
import { Skeleton } from "./skeletor-phaser";
```

---

## 3. Core concepts

### Rig

A rig is everything in one exported file that can be shared by every skeleton made from it: bones, parts, animations and IK constraints. The runtime builds it once per file (cached by the data object) and every `Skeleton` created from the same data reuses it.

### Origin

The rig is authored around `(0, 0)` in the editor. `add.skeleton(x, y, ...)` puts that origin at `(x, y)`. Build your character with its feet, or whatever it should stand on, at the origin.

### Bones and pose

Each bone has a setup pose (position, rotation, length). Animations store **offsets** from the setup pose: a rotation offset and an x/y position offset per bone per keyframe. The runtime samples the playing animations, adds the offsets to the setup pose and solves the hierarchy from parents to children.

Bones must be listed **parents first** in the file. The editor exports them that way.

### Parts

A part is a drawable (a sprite image, or a coloured rectangle) attached to a bone with its own offset and rotation. Parts are drawn in the order they appear in the file, back to front.

### Coordinate spaces

This is the most common source of confusion. There are three spaces:

| Space | What it is | Where you meet it |
|---|---|---|
| **World** | Scene coordinates, after the skeleton's position, flip, scale and rotation | `setIKTarget`, `setIKPole`, `aimBone`, `aimAttached`, `getBoneWorld`, targets from `getIKTarget` |
| **Skeleton space** | Coordinates inside the skeleton, before its position and flip | `getBone`, children added with `attachToBone`, anything you `add()` to the skeleton |
| **Bone space** | Relative to one bone: x along the bone, y across it | `attachToBone` offsets (`x`, `y`) |

Everything that takes a position **from the game** takes **world** coordinates, and the runtime converts into skeleton space itself with the inverse of the object's world matrix. That is why flipping the character never needs mirror maths in your code.

### Angles and units

All angles are radians. Positions are pixels. Animation time is in frames in the file and seconds in the API (`duration = end / fps`).

---

## 4. Loading and creating

### `this.load.skeleton(key, url, imageFolder?)`

Loads the JSON under `key`, then queues every image that sprite parts reference.

- Images are looked up next to the JSON unless you pass `imageFolder`.
- Images are registered under their exact file name from the export (for example `body.png`).
- Images already in the texture manager are not loaded twice.

```ts
this.load.skeleton("hero", "assets/hero/hero.json");
this.load.skeleton("hero", "assets/hero/hero.json", "assets/shared-parts/");
```

### `this.add.skeleton(x, y, source, options?)`

Creates a `Skeleton` and adds it to the scene.

| Parameter | Type | Description |
|---|---|---|
| `x`, `y` | `number` | World position of the rig origin |
| `source` | `string \| ExportData` | A cache key from `load.skeleton`, or the parsed JSON itself |
| `options` | `string \| SkeletonOptions` | An animation name, or an options object |

```ts
this.add.skeleton(400, 500, "hero", "idle");
this.add.skeleton(400, 500, "hero", { animation: "idle", facing: "left", speed: 1, lit: true });
```

### `SkeletonOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `animation` | `string` | none | Animation to start with. Without one, the skeleton shows its setup pose |
| `speed` | `number` | `1` | Playback speed for everything on this skeleton |
| `facing` | `"left" \| "right"` | as authored | Initial facing |
| `authoredFacing` | `"left" \| "right"` | `"right"` | Which way the art faces in the editor. `setFacing` flips relative to this |
| `lit` | `boolean` | `false` | Start with sprite parts affected by the scene's lights |

`Skeleton` extends `Phaser.GameObjects.Container`, so position, scale, rotation, depth, alpha, tweens and parenting all work as usual. It updates itself every frame; you do not need to call anything to advance it.

If a sprite image is not loaded, the runtime draws a magenta box for that part and logs a warning.

---

## 5. Animation playback

### `play(name, options?)`

Plays an animation. Calling it every frame with the same name is safe: it keeps playing. A non-looping animation plays once and holds its last frame.

```ts
hero.play("run");
hero.play("run", { fade: 0.2 });                  // crossfade from whatever is playing
hero.play("dive", { loop: false, restart: false });
hero.play("throw", { restart: true });            // retrigger from the start
```

| Option | Type | Default | Description |
|---|---|---|---|
| `fade` | `number` | `0` | Seconds to crossfade from the current animation. The old one keeps moving while it fades out |
| `loop` | `boolean` | animation's own flag | Override looping |
| `speed` | `number` | `1` | Speed of this animation |
| `startTime` | `number` | `0` | Start this many seconds in |
| `restart` | `boolean` | `false` | Play from the start even if it is already the current animation |

Without `restart`, calling `play` with the name of the current animation does nothing (apart from updating `speed` if you pass it). This includes a finished non-looping animation: it stays on its last frame. Use `restart: true` to trigger it again.

An unknown name logs a warning listing the available animations and changes nothing.

### `blend(weights, options?)`

Mixes several animations at once, for example from movement speed.

```ts
hero.blend({ walk: 0.3, run: 0.7 });
hero.blend({ walk: 1 - t, run: t }, { fade: 0.2 });
```

- Weights are relative.
- Blended animations share one phase, so footsteps stay in sync even when the clips have different lengths.
- Call it every frame with new weights, or once with `fade` to ease into a mix.
- Anything not mentioned fades out.
- While blending, `animation` returns `null`.

| Option | Description |
|---|---|
| `speed` | Playback speed of the shared phase |
| `fade` | Seconds to ease the weights |

### Transport

| Method | Description |
|---|---|
| `stop()` | Stops everything (base animations and layers) and returns to the setup pose |
| `pause()` / `resume()` | Pause and resume. While paused, time does not advance and no events fire |
| `setTimeScale(s)` | Speed of everything on this skeleton. `1` normal, `0.5` slow motion |
| `setTime(seconds)` | Jump the current animation to a time. Useful to sync two characters |

### Queries

| Member | Description |
|---|---|
| `animation` | Name of the current animation (the newest while crossfading). `null` when stopped or blending |
| `isPlaying(name?)` | Whether the current animation is playing (and matches `name` if given). `false` while paused |
| `has(name)` | Whether the file contains an animation with this name |
| `getAnimationNames()` | All animation names |

### Interpolation

Keys interpolate by the `interp` value on the earlier key:

- `linear`: straight line between keys
- `smooth`: smoothstep easing
- `step`: holds the earlier key until the next one

Rotations interpolate the short way round, never more than half a turn. Before the first key and after the last key, the first and last values are held.

---

## 6. Animation layers

Layers play an animation on top of the base one, on some bones only. Use them for upper-body actions while the legs keep running: throw, reload, heal, flinch.

```ts
hero.play("run");                                                    // the base
hero.playLayer("upper", "throw", { bones: ["spine"], loop: false }); // the spine and everything above it throws
```

### `playLayer(slot, name, options?)`

A **slot** is a name for the layer (`"upper"`, `"face"`). Each slot plays one animation. A new animation in the same slot crossfades from the old one. Different slots play at the same time. Calling with the same animation every frame is fine.

| Option | Type | Default | Description |
|---|---|---|---|
| `bones` | `string[]` | all bones | Only these bones (and, by default, everything below them) play the animation |
| `children` | `boolean` | `true` | Include the bones below the listed ones |
| `except` | `string[]` | none | Leave these bones (and the ones below them, if `children`) out |
| `mode` | `"replace" \| "add"` | `"replace"` | `replace`: the layer takes over the masked bones it has keys for. `add`: its movement is added on top (breathing, hit reactions) |
| `priority` | `number` | `0` | Higher is applied last, so it wins where layers overlap. Equal priority: the later one wins |
| `weight` | `number` | `1` | 0 to 1: how strongly it applies. Calling again with another weight changes it |
| `fade` | `number` | `0.1` | Seconds to fade in |
| `fadeOut` | `number` | `fade` | Seconds to fade out at the end of a non-looping animation, or on `stopLayer` |
| `loop` | `boolean` | animation's flag | Override looping |
| `speed` | `number` | `1` | Playback speed |
| `startTime` | `number` | `0` | Start this many seconds in |
| `restart` | `boolean` | `false` | Start over even if it is already playing in this slot |
| `keyedOnly` | `boolean` | `true` | `true`: only bones the animation has keys for are touched, so the rest keeps playing the base. `false`: every masked bone is forced to this animation, a bone with no keys goes to its setup pose |

The layer animation only needs keys for the bones that should move.

A non-looping layer fades out by itself at its end, starting early enough to be gone when the animation finishes.

### `stopLayer(slot?, fadeSeconds = 0.1)`

Fades a layer out and removes it. Without `slot`, every layer is stopped. With `fadeSeconds = 0` it is removed immediately.

### `isLayerPlaying(slot, name?)`

Whether something is playing in that slot (and matches `name` if given).

An invalid bone name in `bones` or `except` logs a warning and the layer is not started.

---

## 7. Facing

The whole character, sprites included, is mirrored by negating `scaleX`.

| Member | Description |
|---|---|
| `facing` | `"left"` or `"right"` |
| `setFacing(dir, turnSeconds = 0)` | Set the facing. With `turnSeconds > 0` it squashes through the middle over that time instead of snapping |
| `faceLeft(turnSeconds?)` / `faceRight(turnSeconds?)` | Set a specific facing, no-op if already facing that way |
| `flip(turnSeconds?)` | Toggle |
| `faceTowards(worldX, turnSeconds = 0, deadZone = 1)` | Face a world x position. Ignored while within `deadZone` pixels of the skeleton's x, so it does not jitter |

`authoredFacing` (see [options](#skeletonoptions)) tells the runtime which way the art faces in the editor, so `"left"` and `"right"` always mean what you expect.

Because the flip is a scale, anything that is a child of the skeleton is mirrored too, including its rotation. See [Attachments](#12-attachments) for how to aim a child object correctly.

---

## 8. Bone overrides

Overrides steer a bone from code on top of the animation (procedural animation). They are applied after the animations are blended and before IK.

> **Overrides are persistent.** They stay active until you call `clearBoneOverride`. If you set one only while a condition holds (for example while aiming), clear it when the condition ends.

### `aimBone(bone, worldX, worldY, options?)`

Points a bone at a world position. Call it every frame with the target's position. Flipping, moving and scaling are handled for you.

```ts
hero.aimBone("head", pointer.worldX, pointer.worldY, {
    offset: -Math.PI / 2,   // the art does not point along the bone
    limit: 0.6,             // stay within 0.6 rad of the setup rotation
    weight: 0.8,
});
```

| Option | Description |
|---|---|
| `offset` | Radians added to the angle, for art or bones that do not point along their own axis |
| `limit` | Keep the bone within this many radians of its setup rotation (for example a head that cannot turn around) |
| `weight` | 0 to 1, how much the override wins over the animation (default 1) |

### `setBoneRotation(bone, radians, mode = "add", options?)`

| Mode | Meaning |
|---|---|
| `"add"` | Turn the bone by `radians` more than the animation does (breathing, recoil) |
| `"local"` | Set its rotation relative to its parent |
| `"world"` | Set its rotation in the skeleton's space |

### `clearBoneOverride(bone?)`

Removes the override on one bone, or on all bones when called without arguments.

Easing an override out is done by animating `weight` yourself and clearing the override once it reaches zero.

---

## 9. Inverse kinematics

The runtime solves **two-bone** IK chains (a leg: thigh and shin; an arm: upper arm and forearm) defined in the editor. A chain makes its lower bone's tip reach a point. The animation still drives everything else.

### IK in the file

```json
{
  "name": "IK 3",
  "boneA": "arm_R",
  "boneB": "hand_R",
  "bend": 1,
  "target": "r-hand-target",
  "pole": "IK 3 pole"
}
```

- `boneB` must be a child of `boneA`. Otherwise the constraint is skipped with a warning.
- `bend` (`1` or `-1`) is which side of the root-to-target line the middle joint (knee or elbow) bends to.
- `target` and `pole` are the editor names of the target and pole objects. If missing, they default to `"<name> target"` and `"<name> pole"`.

### Names

Each IK has up to three names, and different methods accept different ones:

| Name | Example | Accepted by |
|---|---|---|
| The IK's own name | `"IK 3"` | every IK method |
| Its target object's name | `"r-hand-target"` | `setIKTarget`, `setIKPole`, `clearIKPole`, `setIKBend`, `setIKWeight`, `clearIK`, `isIKActive`, `getIKTarget`, `bindIKTarget`, `plantBone`, `unplantBone`, `getPlantInfo` |
| Its pole object's name | `"IK 3 pole"` | `setIKTarget`, `setIKPole`, `clearIKPole`, `setIKBend`, `setIKWeight`, `clearIK`, `isIKActive`, `getIKPole`, `bindIKPole` |

A name that matches nothing logs a warning that lists the valid IK, target and pole names, which makes typos easy to find. Names are case-sensitive and must match exactly, including hyphens versus underscores.

Use `getIKNames()`, `getIKTargetNames()` and `getIKPoleNames()` to see them at runtime.

### Driving a chain with numbers

```ts
hero.setIKTarget("IK 1", groundX, groundY);        // world coordinates; switches the IK on
hero.setIKTarget("IK 1", groundX, groundY, 0.5);   // with an explicit weight
```

`setIKTarget(name, worldX, worldY, weight?)` stores a world-space target and switches the IK on (weight 1) unless you pass a weight or already set one. Call it every frame with the position you want. Out of reach, the chain stretches straight at the target.

### Driving a chain with an object

```ts
const foot = hero.getIKTarget("IK 1 target");
foot.setPosition(groundX, groundY);               // world coordinates
```

`getIKTarget(name)` returns an object whose `x`/`y` are **world coordinates**. The first call creates an invisible Zone at the tip of the chain (so nothing jumps), switches the IK on and returns it. You can move it, tween it, or attach it to something. `getIKTarget` returns the object you bound if you used `bindIKTarget`. For an unknown name it logs a warning and returns a detached Zone, so `getIKTarget("typo").setPosition(...)` does not crash but also does nothing.

```ts
hero.bindIKTarget("IK 1", mySprite);   // the chain follows mySprite every frame
hero.bindIKTarget("IK 1", null);       // let go
```

The target object is read when the skeleton updates (before your `update()`). Call `hero.step(0)` after moving it if you need the result in the same frame.

> Pick one way per chain. Plain numbers (`setIKTarget`) take over from an object, and calling `getIKTarget` for a chain you drive with numbers switches the IK on as a side effect.

### Pole (elbow and knee direction)

```ts
hero.setIKPole("IK 3", poleX, poleY);   // the joint bends toward this world position
hero.clearIKPole("IK 3");               // back to the exported bend direction
hero.setIKBend("IK 3", -1);             // force the other way round
```

Without a pole, the joint bends the way it did in the editor **relative to the character**, so it keeps bending forward when the character flips. With a pole, the bend side is the side of the root-to-target line that the pole is on. The pole only has a visible effect when the chain is bent. A fully stretched chain has no bend. A pole that sits exactly on the root-to-target line gives no clear side, so offset it a little to keep the joint from flickering.

`getIKPole(name)` returns a controllable object for the pole, created in front of the joint on the side the editor had it. `bindIKPole(name, obj)` binds your own object.

### Weight

```ts
hero.setIKWeight("IK 3", 1);          // full IK
hero.setIKWeight("IK 3", 0, 0.2);     // let go smoothly over 0.2 s
hero.clearIK("IK 3");                 // off immediately, target and pole released
hero.clearIK();                       // all of them
hero.isIKActive("IK 3");              // has a target and a weight above 0
```

Weight blends between the animation (0) and the solved pose (1). Weights fade over time when you pass `fadeSeconds`; otherwise they snap.

### Behaviour notes

- Bones of an active IK take their **setup position**, not the animation's position offsets (like in the editor). Their **rotation** is replaced by the solved rotation, blended by weight.
- A bone is "active" when the chain has a target and a weight above 0.
- The solver stretches the chain straight at the target when it is out of reach, and keeps it from fully folding when the target is too close.
- Destroyed target or pole objects are released automatically.

---

## 10. Foot planting

Keeps legs on the ground over slopes and steps without breaking the animation. You provide a ground check (typically a raycast), and the runtime plants the foot while the animation says it is on the floor and lets the animation lift it while it swings.

```ts
hero.plantBone("IK 1", {
    ground: (x, y) => this.groundYAt(x, y),   // world y of the ground, or null
    bone: "foot_L",
});
hero.plantBone("IK 2", {
    ground: (x, y) => this.groundYAt(x, y),
    bone: "foot_R",
});
```

Call it **once** per leg; after that it runs every frame by itself. It takes over that IK, so do not also call `setIKTarget` or `getIKTarget` on it. `unplantBone(name, fadeSeconds = 0.1)` gives it back.

### How it works

Each frame, for every planted leg:

1. It poses the skeleton with the animation alone (IK off) and reads where the animated foot is.
2. It calls your `ground(worldX, worldY)` with the foot tip.
3. It measures how high the animated foot is above the flat ground the animation was made for. Close to the ground means planted, high means swinging.
4. It shifts the chain tip by the difference between the real ground and the flat ground, and sets the IK weight from how planted the foot is, eased by `smooth`.

### `PlantOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `ground` | `(worldX, worldY) => number \| null` | required | Returns the world y of the ground under the point, or `null` if none (then the animation plays untouched) |
| `bone` | `string` | the IK's lower bone | The bone whose tip is checked against the ground. Use a foot bone below the IK chain if you have one |
| `groundLevel` | `number \| () => number` | the skeleton's own y | World y of the flat ground the animation was made for |
| `plantHeight` | `number` | `48` | How close to the flat ground (px) the animated foot must be to count as planted. Higher: the foot sticks longer in each step |
| `offset` | `number` | `0` | Keep the foot this many pixels above the ground |
| `maxShift` | `number` | `100` | Never move the foot more than this far up or down from the animation |
| `smooth` | `number` | `0.05` | Seconds to ease the plant on and off so the foot does not pop (`0` = none) |

### Debugging

```ts
hero.setPlantDebug(true);                          // draws the planting in world space
const info = hero.getPlantInfo("IK 1");            // live PlantInfo, updated every frame
console.log(info?.hit, info?.groundY, info?.planted);
```

Debug drawing: white dot is the foot tip your ground check was asked about, a yellow line is the ray down to the ground, a green dot means hit and planted, orange means hit but in the air, a red ring means no ground found, and a cyan dot with a line shows where the leg is sent from the chain tip.

`getPlantInfo` returns `null` if that leg is not planted. See `PlantInfo` in the source for every field (`hit`, `groundY`, `footX/Y`, `chainX/Y`, `targetX/Y`, `level`, `lift`, `shift`, `clamped`, `planted`, `weight`).

---

## 11. Parts, skins and lighting

| Method | Description |
|---|---|
| `getPartNames()` | Names of all parts, in draw order (back to front) |
| `getPart(name)` | The Phaser object drawing the part (`Image` or `Rectangle`), or `null` with a warning |
| `setPartImage(part, textureKey)` | Show a different image on a sprite part. The image must be loaded and is drawn at the part's size from the editor, so give it the same proportions |
| `setSkin(images)` | Swap several parts at once: `setSkin({ body: "body_red.png", arm: "arm_red.png" })`. Parts you do not list go back to the editor images. `setSkin(null)` restores all |

Part names are the names from the editor. If two parts share a name, the first one wins for lookups.

### Lighting

```ts
this.lights.enable().setAmbientColor(0x303030);
this.lights.addLight(400, 300, 300);
hero.setLit(true);        // or the `lit: true` option
hero.isLit;               // current state
```

Works with Phaser 4 (`setLighting`) and Phaser 3 (the Light2D pipeline). Only sprite parts are lit; plain rectangles are not. Objects you attach with `attachToBone` are yours: light them yourself.

---

## 12. Attachments

`attachToBone(obj, bone, options?)` glues any game object (a gun, a hat, another `Skeleton`) to a bone. The object becomes a child of the skeleton, so it flips, scales and moves with the character, and it follows the bone every frame.

```ts
hero.attachToBone(gun, "hand_R", { at: "tip" });                   // glued to the end of the bone
hero.attachToBone(gun, "hand_R", { below: "r-hand" });             // over the body, under the right hand
hero.attachToBone(cap, "head", { above: "head", rotation: 0.2 });
```

| Option | Type | Default | Description |
|---|---|---|---|
| `below` | `string` | none | Draw just below this part (by editor name) |
| `above` | `string` | none | Draw just above this part |
| `at` | `"pivot" \| "tip" \| number` | `"pivot"` | Where on the bone: the start, the end, or a fraction (0 = pivot, 0.5 = middle, 1 = tip) |
| `x`, `y` | `number` | `0` | Offset from that point in bone space (x along the bone, y across it) |
| `rotation` | `number` | `0` | Extra rotation in radians |
| `followRotation` | `boolean` | `true` | `false`: only follow the bone's position and keep the object's own rotation |

With neither `below` nor `above`, the object is drawn on top of everything. Attaching again moves it. `detach(obj, remove = true)` lets go (and removes it from the skeleton unless `remove` is `false`). Destroyed objects are released automatically.

### Aiming an attached object

```ts
hero.attachToBone(gun, "hand_R", { at: "tip", followRotation: false });

// every frame
hero.aimAttached(gun, pointer.worldX, pointer.worldY);
```

`aimAttached(obj, worldX, worldY, offset = 0)` rotates the object to point at a world position, correctly whether the character faces left or right. Use `offset` (radians) for art that does not point right at rotation 0.

**Do not** call `gun.setRotation(angleInTheWorld)` for a child of a flipped skeleton: the rotation is applied in skeleton space, so a world angle ends up mirrored. And you must attach with `followRotation: false`, otherwise the runtime overwrites the rotation with the bone's rotation on every pose update, and your aiming appears to do nothing.

---

## 13. Reading bones

| Method | Space | Description |
|---|---|---|
| `hasBone(name)` | | Whether the bone exists |
| `getBone(name, out?)` | skeleton | Bone transform as of the last update |
| `getBoneWorld(name, out?)` | world | Bone transform including the skeleton's position, flip, scale and rotation. Handy for muzzles, hands and effects |
| `getAnimatedBoneWorld(name, out?)` | world | Where the **animation alone** puts the bone (no IK). It poses the skeleton twice, so use it for a few bones per frame, not all of them |

All three return a `BonePose`, or `null` if the bone does not exist:

```ts
type BonePose = {
    x: number;        // pivot (start of the bone)
    y: number;
    rotation: number; // radians
    tipX: number;     // end of the bone
    tipY: number;
};
```

Pass your own `out` object to avoid allocating; the methods write into it and return it. Reuse one object per call site:

```ts
private readonly pose: BonePose = { x: 0, y: 0, rotation: 0, tipX: 0, tipY: 0 };

const hand = hero.getBoneWorld("hand_R", this.pose)!;
```

Note that `getBone` and `getBoneWorld` reflect the pose as of the **last update**, so a bone read in your `update()` before you change an animation or an IK target is one frame behind. See [Update order](#15-update-order-and-timing).

---

## 14. Events

`Skeleton` is a Phaser event emitter. Event names are in `SkeletonEvents`:

| Constant | Value | Arguments | When |
|---|---|---|---|
| `SkeletonEvents.START` | `"animationstart"` | `(name, slot?)` | A `play()` or `playLayer()` started |
| `SkeletonEvents.COMPLETE` | `"animationcomplete"` | `(name, slot?)` | A non-looping animation reached its end |
| `SkeletonEvents.LOOP` | `"animationloop"` | `(name, slot?)` | A looping animation wrapped around |

`slot` is only set for layer animations.

```ts
import { SkeletonEvents } from "./skeletor-phaser";

hero.on(SkeletonEvents.COMPLETE, (name: string) => {
    if (name === "dive") this.onDiveFinished();
});
```

Completion and loop events are queued during the update and emitted **last**, so a handler can safely call `play()`.

---

## 15. Update order and timing

The skeleton updates itself in Phaser's `preUpdate` (`step(dt)`), which runs after your scene's `update()`. Each update:

1. Advances IK weights, blended-animation phase, base animations and layers by `dt`.
2. Updates foot planting.
3. Poses every bone and puts every part (and attachment) in place.
4. Emits queued events.

Calling `play`, `playLayer`, `blend`, `setTime`, `stop` or an IK or override method also re-poses immediately (cheaply), except IK targets and overrides, which are applied at the next pose.

### One-frame lag and `step(0)`

Anything you read from the skeleton in your own `update()` (`getBone`, `getBoneWorld`, or a child object's transform) reflects the previous pose. If you compute something from it and feed it back (aim the gun from where the hand is, then place the other hand from where the gun is), the values are one step behind, which shows up as flicker when the animation changes.

`step(0)` re-poses the skeleton without advancing any time. Call it after you set IK targets or overrides, and before you read the result:

```ts
this.hero.setIKTarget("IK 3", x, y, 1);
this.hero.step(0);                       // apply it now
const gun = this.gun.getWorldTransformMatrix(matrix);
```

Order of operations that avoids lag for a character that aims:

1. Decide the facing.
2. Choose and play the animation (this changes the pose).
3. Set IK targets and overrides from the new pose, and call `step(0)`.
4. Read results (gun position, muzzle) and continue.

`step(0)` costs a full pose solve, so use it sparingly on crowds.

You can also drive time yourself by calling `step(dt)` with your own delta (seconds). `dt` is multiplied by the skeleton's time scale and ignored while paused.

---

## 16. Recipes

### Aim a gun with arm IK, flip-safe

```ts
const ARM_BONE = "arm_R";           // upper bone of the arm chain
const ARM_IK = "IK 3";
const REACH = 45;                   // a little less than the arm length, so the elbow bends

private readonly armPose: BonePose = { x: 0, y: 0, rotation: 0, tipX: 0, tipY: 0 };

createGun() {
    this.gun = this.scene.add.rectangle(0, 0, 150, 30, 0xfff000).setOrigin(0.1, 0.5);
    this.sprite.attachToBone(this.gun, "hand_R", { at: "tip", followRotation: false });
}

aim(targetX: number, targetY: number, aiming: boolean) {
    this.sprite.faceTowards(targetX, 0, 4);

    const s = this.sprite.getBoneWorld(ARM_BONE, this.armPose)!;
    const angle = Math.atan2(targetY - s.y, targetX - s.x);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);

    this.sprite.setIKTarget(ARM_IK, s.x + ux * REACH, s.y + uy * REACH, aiming ? 1 : 0);

    // elbow pole: behind the shoulder, nudged toward the ground
    let px = -uy, py = ux;
    if (py < 0) { px = -px; py = -py; }
    this.sprite.setIKPole(ARM_IK, s.x - ux * 60 + px * 20, s.y - uy * 60 + py * 20);

    this.sprite.step(0);
    if (aiming) this.sprite.aimAttached(this.gun, targetX, targetY);
}
```

World coordinates throughout; no mirror maths.

### Run backward while aiming forward

Facing comes from the aim, so moving against the facing means running backward:

```ts
const facingDir = hero.facing === "right" ? 1 : -1;
const movingBack = velocityX * facingDir < -5;       // small threshold avoids flicker
hero.play(movingBack ? "run-back" : "run", { fade: 0.2 });
```

Decide the facing before choosing the animation, and do not also set the facing from velocity in your animation code.

### Face the movement direction while diving

```ts
if (isDodging) {
    if (vx !== 0) hero.faceTowards(hero.x + vx, 0, 0);
} else if (isShooting) {
    hero.faceTowards(targetX, 0, 4);
} else if (vx !== 0) {
    hero.faceTowards(hero.x + vx, 0, 0);
}
```

Fade aim IK out during the dive (`setIKWeight(name, 0, 0.1)`) so the dive animation controls the arms.

### Ease an override out

```ts
this.headWeight += ((aiming ? 0.8 : 0) - this.headWeight) * Math.min(1, dt * 12);
if (this.headWeight > 0.01) {
    hero.aimBone("head", tx, ty, { offset: -Math.PI / 2, limit: 0.6, weight: this.headWeight });
} else {
    this.headWeight = 0;
    hero.clearBoneOverride("head");
}
```

### Upper-body action over locomotion

```ts
hero.play(moving ? "run" : "idle", { fade: 0.15 });
if (reloadPressed) hero.playLayer("upper", "reload", { bones: ["spine"], loop: false, restart: true });
```

### Blend walk and run from speed

```ts
const t = Phaser.Math.Clamp((speed - walkSpeed) / (runSpeed - walkSpeed), 0, 1);
hero.blend({ walk: 1 - t, run: t });
```

### Hit reaction added on top

```ts
hero.playLayer("hit", "flinch", { mode: "add", loop: false, priority: 5, fade: 0.05 });
```

---

## 17. Troubleshooting

All runtime warnings are prefixed `[skeletor]`. They list the valid names, so read them first.

| Symptom | Likely cause | Fix |
|---|---|---|
| `nothing called "x"` warning from an IK method | The name does not match an IK, target or pole name exactly (check hyphens versus underscores, case) | Use a name from the warning's list, or print `getIKNames()` / `getIKTargetNames()` |
| `getIKTarget(...).setPosition(...)` does nothing | Wrong name, so a detached throwaway Zone was returned | Fix the name; check the console for the warning |
| IK target is in the wrong place, or wrong when flipped | Passing skeleton-local coordinates (for example a child's `x`/`y`) | IK targets, poles and `aimBone` targets are **world** coordinates |
| Arm points at the target but the elbow never bends | The target is beyond the arm's reach, so the chain is stretched straight | Place the target within reach (a little under the total bone length). The pole only matters when the chain is bent |
| Elbow flickers between two sides | The pole is exactly on the line from shoulder to target | Offset the pole sideways |
| Elbow bends the wrong way | Bend side is wrong for your art | `setIKBend(name, -1)`, or use a pole |
| Gun rotation does nothing, or is mirrored when flipped | Attached with `followRotation: true`, or `setRotation` used with a world angle | Attach with `followRotation: false` and use `aimAttached` |
| Gun or hand flickers when the animation changes | Reading the pose before it has been updated (one-frame lag) | Decide facing, play the animation, set IK, `step(0)`, then read the result ([Update order](#15-update-order-and-timing)) |
| A bone keeps pointing at the target after you stop aiming | `aimBone` is persistent | Call `clearBoneOverride(bone)` when done |
| An animation does not change | `play` was called with the current animation's name, or a finished non-looping one | Pass `restart: true` to retrigger |
| `no animation called "x"` | Name mismatch | The warning lists the available names |
| Magenta box instead of a part | The image is not loaded under its exact export name | Use `load.skeleton`, or load the image under that name |
| Character flips every frame, or flips the wrong way | Two pieces of code set the facing, or the art's facing differs from the editor | Let one place decide the facing; set `authoredFacing` |
| IK constraint is skipped | `boneB` is not a child of `boneA` | Fix the chain in the editor |
| Plant does not plant | `ground` returned `null`, or the foot is far above the flat ground | Turn on `setPlantDebug(true)` and read `getPlantInfo` |
| `[skeletor] nothing loaded under "key"` (thrown) | The JSON was not loaded under that key | Call `this.load.skeleton(key, url)` in `preload` |
| `this is not an exported animation_tool file` (thrown) | Wrong or outdated JSON | Re-export from the editor (`format` must be `"animation_tool"`) |

---

## 18. Export format reference

The exported JSON has this shape. You normally do not edit it by hand.

```jsonc
{
  "format": "animation_tool",
  "version": 1,
  "units": { "angle": "radians", "position": "pixels", "time": "frames" },
  "bones": [ /* parents first */ ],
  "parts": [ /* back to front */ ],
  "animations": { /* by name */ },
  "ik": [ /* optional */ ]
}
```

### Bones

```jsonc
{
  "name": "arm_R",
  "parent": "spine",      // null for a root
  "length": 28.23,
  "x": 45.9, "y": -10.3,  // setup position relative to the parent's pivot
  "rotation": 3.1356,     // setup rotation relative to the parent
  "connected": false
}
```

### Parts

```jsonc
{
  "name": "r-arm",
  "type": "sprite",       // or "rect" with a "color"
  "bone": "arm_R",        // null = free (not attached to a bone)
  "x": -18.47, "y": -27.66, "rotation": -1.5588,   // offset relative to the bone
  "width": 300, "height": 300,
  "color": "#ffffff",
  "visible": true,
  "image": "r-arm.png"
}
```

### Animations

```jsonc
"run": {
  "fps": 24,
  "end": 18,              // last frame
  "duration": 0.75,       // seconds (end / fps)
  "loop": true,
  "baked": false,
  "bones": {
    "arm_R": [
      { "frame": 0, "time": 0, "rotation": -0.37, "x": 0, "y": 0, "interp": "linear" },
      { "frame": 9, "time": 0.375, "rotation": -0.37, "x": 0, "y": 0, "interp": "linear" }
    ]
  }
}
```

Key values are **offsets** from the setup pose. A bone without keys in an animation is untouched by it. `interp` is `"linear"`, `"smooth"` or `"step"`.

### IK

See [Inverse kinematics](#9-inverse-kinematics).

---

## 19. Limitations

- IK solves **two-bone** chains only.
- No mesh deformation, weights or skinning: parts are rigid sprites or rectangles attached to bones.
- No animation events or sound keys in the format.
- Facing is a mirror of the whole object (negative `scaleX`); art with baked-in lighting direction will mirror too.
- A bone belongs to at most one IK chain as an upper bone and one as a lower bone.
- Overrides are persistent until cleared and apply to one bone each.

---

## API summary

```ts
// loading / creating
this.load.skeleton(key, url, imageFolder?)
this.add.skeleton(x, y, source, options?)

// animation
play(name, opts?) · blend(weights, opts?) · stop() · pause() · resume()
setTimeScale(s) · setTime(seconds) · isPlaying(name?) · has(name)
getAnimationNames() · animation

// layers
playLayer(slot, name, opts?) · stopLayer(slot?, fade?) · isLayerPlaying(slot, name?)

// facing
facing · setFacing(dir, turn?) · faceLeft() · faceRight() · flip() · faceTowards(x, turn?, dead?)

// bone overrides
aimBone(bone, x, y, opts?) · setBoneRotation(bone, rad, mode?, opts?) · clearBoneOverride(bone?)

// IK
getIKNames() · getIKTargetNames() · getIKPoleNames()
setIKTarget(name, x, y, weight?) · setIKPole(name, x, y) · clearIKPole(name)
setIKBend(name, 1 | -1) · setIKWeight(name, w, fade?) · clearIK(name?) · isIKActive(name)
getIKTarget(name) · getIKPole(name) · bindIKTarget(name, obj | null) · bindIKPole(name, obj | null)

// planting
plantBone(name, opts) · unplantBone(name, fade?) · getPlantInfo(name) · setPlantDebug(on?)

// parts
getPartNames() · getPart(name) · setPartImage(part, key) · setSkin(images | null) · setLit(on?) · isLit

// attachments
attachToBone(obj, bone, opts?) · aimAttached(obj, x, y, offset?) · detach(obj, remove?)

// reading
hasBone(name) · getBone(name, out?) · getBoneWorld(name, out?) · getAnimatedBoneWorld(name, out?)

// time
step(dt)          // preUpdate calls this; step(0) re-poses without advancing time

// events
SkeletonEvents.START · COMPLETE · LOOP
```
