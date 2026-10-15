/*
 * Wildlife for the winter landscape: a fox, a deer, squirrels, cardinals, a night owl and a
 * snowman.
 *
 * Structure, borrowed from how games do ambient life:
 *   Director  decides who wanders in next, by weight and cooldown: always at least one animal,
 *             at most MAX_ANIMALS, and nobody new while a card is being read.
 *   Brains    one generator per animal that picks its own destinations in the play area and
 *             reacts to the others: deer roam and graze and bolt from a fox; squirrels forage,
 *             dash between trees and flee up the nearest one; the fox wanders and stalks any
 *             squirrel it spots; birds hop between perches; the owl glides between tree tops.
 *             (Yield a number to wait that many seconds, nothing to wait one frame.)
 *   Actors    cloned models with an animation mixer, walking over the terrain and around
 *             trees and the snowman.
 * Animals enter and leave beyond either screen edge, so nothing pops in or out in view.
 *
 * Localhost-only switches: ?wild=deer|squirrel|fox|hunt|birds|owl|lineup keeps spawning
 * that kind, ?wildspeed=3 runs everything faster.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { CCDIKSolver } from "three/addons/animation/CCDIKSolver.js";

// Fewer on phones: the view is narrower and the CPU smaller.
const MAX_ANIMALS = typeof innerWidth !== "undefined" && innerWidth < 560 ? 5 : 8;
const FIRST_SPAWN_AFTER = 1.5; // seconds after wildlife loads
const GAP = [6, 14]; // seconds between arrivals

// Leg chains for leg IK: upper and lower bone, and the node at the foot.
// Quaternius rig: the lower leg ends where the rig's own Blender IK controls sit.
// GLTFLoader strips dots from node names ("FrontUpperLeg.L" -> "FrontUpperLegL").
const QUATERNIUS_LEGS = ["L", "R"].flatMap((side) => [
  { upper: "FrontUpperLeg" + side, lower: "FrontLowerLeg" + side, foot: "IKFrontLeg" + side, front: true },
  { upper: "BackUpperLeg" + side, lower: "BackLowerLeg" + side, foot: "IKBackLeg" + side, front: false },
]);
// blam's squirrel (3ds Max rig): Box08-11 are the front legs, Box13-16 the back; Dummy01-04
// are the foot helpers.
const SQUIRREL_LEGS = [
  { upper: "Box08", lower: "Box09", foot: "Dummy03", front: true },
  { upper: "Box10", lower: "Box11", foot: "Dummy04", front: true },
  { upper: "Box13", lower: "Box14", foot: "Dummy01", front: false },
  { upper: "Box16", lower: "Box15", foot: "Dummy02", front: false },
];

// How each model is normalized: target size in world units, which way it faces, recolors.
// maxRate caps how fast a walk cycle may play to keep up with the animal's pace.
const SPECIES = {
  fox: { url: "/models/fox.glb", length: 1.9, shadow: 0.7, legs: QUATERNIUS_LEGS, turnRadius: 1.4, recolor: { Main: 0xe4e9f0, Main_Light: 0xc3cfdc } }, // cool white, so it separates from the snow
  deer: { url: "/models/deer.glb", length: 2.6, shadow: 0.9, legs: QUATERNIUS_LEGS, turnRadius: 2.2 },
  squirrel: { url: "/models/squirrel.glb", length: 0.95, shadow: 0.35, legs: SQUIRREL_LEGS, ikRate: 12, turnRadius: 0.3, fade: 0.12, maxRate: 3.2 },
  // Gobkit owl: rigged wings (LeftHand/RightHand), flapped in code; glows a little at night.
  owl: { url: "/models/owl.glb", height: 1.5, glow: 0.45, wings: true },
  bird: { url: "/models/bird.glb", length: 1.05, tint: "cardinal" },
  snowman: { url: "/models/snowman.glb", height: 3.1, shadow: 1.1 },
};

// How often a pounce succeeds (the fox carries the squirrel off).
const CATCH_CHANCE = 0.3;

// Walking and running speeds (world units/second), matched by eye to each walk cycle.
// The squirrel's one bounding cycle ("move") covers the ground at about 1.1.
const SPEED = { deer: { walk: 1.25, run: 5.2 }, fox: { walk: 1.1, run: 5.5 }, squirrel: { walk: 1.1, run: 1.1 } };

const local = ["localhost", "127.0.0.1"].includes(location.hostname);
const params = new URLSearchParams(location.search);
const FORCE = local ? params.get("wild") : null;
const TIME_SCALE = local ? Number(params.get("wildspeed")) || 1 : 1;
const ikOn = !(local && params.get("ik") === "0");
const CATCHES = local && params.get("catch") === "1"; // every pounce succeeds

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export async function createWildlife({ scene, camera, renderer, heightAt, halfWidthAt, trees, isNight, motion }) {
  const loader = new GLTFLoader();
  const sources = {};
  const wanted = motion ? Object.keys(SPECIES) : ["snowman"];
  const files = {};
  await Promise.all(
    wanted.map(async (name) => {
      try {
        const url = SPECIES[name].url;
        files[url] ||= loader.loadAsync(url);
        sources[name] = await files[url];
      } catch (err) {
        console.warn(`Wildlife: couldn't load ${name}`, err);
      }
    })
  );

  // The clips loop, but some end on a slightly different pose than they start with, which
  // shows as a pop on every cycle (worst in the gallops). End each track on its first key.
  for (const src of new Set(Object.values(sources))) {
    for (const clip of src.animations) {
      for (const track of clip.tracks) {
        const { times, values } = track, n = values.length / times.length;
        if (times.length < 2 || times[times.length - 1] < clip.duration - 1e-4) continue;
        values.copyWithin(values.length - n, 0, n);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Actors

  const actors = new Set();

  // Soft contact shadow: a blurred oval on the snow that grounds each animal (and gives the
  // white snowman and fox an edge against white snow).
  const shadowTexture = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(40,60,90,0.42)");
    grad.addColorStop(0.55, "rgba(40,60,90,0.18)");
    grad.addColorStop(1, "rgba(40,60,90,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const shadowGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  function addShadow(actor, radius) {
    const mat = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false });
    const m = new THREE.Mesh(shadowGeometry, mat);
    m.scale.set(radius * 2.4, 1, radius * 1.6);
    m.renderOrder = -1;
    actor.root.add(m);
    actor.shadow = m;
  }

  function updateShadow(a) {
    if (!a.shadow) return;
    const p = a.root.position;
    const ground = heightAt(p.x, p.z);
    const above = p.y - ground;
    a.shadow.position.y = -above + 0.05;
    a.shadow.material.opacity = Math.max(0, 1 - above / 1.2);
    a.shadow.rotation.y = -a.root.rotation.y + a.heading; // stays aligned with the body
  }

  function make(name) {
    const src = sources[name];
    if (!src) return null;
    const spec = SPECIES[name];
    const model = SkeletonUtils.clone(src.scene);
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false; // skinned bounds are unreliable once animated
      o.material = o.material.clone();
      const color = spec.recolor?.[o.material.name];
      if (color != null) o.material.color.set(color);
      if (spec.tint) tint(o, spec.tint);
      if (spec.glow && o.material.map) {
        o.material.emissive = new THREE.Color(0xffffff);
        o.material.emissiveMap = o.material.map;
        o.material.emissiveIntensity = spec.glow;
      }
    });

    // Normalize: measure, scale to the target size, stand it on y = 0 and center it.
    if (spec.yaw) model.rotation.y += spec.yaw;
    const holder = new THREE.Group();
    holder.add(model);
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model, true);
    const size = box.getSize(new THREE.Vector3());
    const scale = spec.height ? spec.height / size.y : spec.length / Math.max(size.x, size.z);
    model.scale.multiplyScalar(scale);
    holder.updateMatrixWorld(true);
    box.setFromObject(model, true);
    const center = box.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box.min.y;

    const root = new THREE.Group(); // position and heading live here
    root.add(holder);
    const actor = { name, root, holder, mixer: null, actions: {}, current: null, x: 0, z: 0, heading: 0, lift: 0 };
    if (src.animations.length) {
      actor.mixer = new THREE.AnimationMixer(model);
      for (const clip of src.animations) actor.actions[clip.name] = actor.mixer.clipAction(clip);
    }
    if (spec.shadow) addShadow(actor, spec.shadow);
    if (spec.legs) rigLegs(actor, model, spec.legs);
    actor.head = model.getObjectByName("Head");
    if (spec.wings) {
      // Wing bones and their folded rest angles (Gobkit rig: +z raises the left, -z the right).
      model.traverse((o) => {
        if (o.isBone && o.name === "LeftHand") actor.wingL = { bone: o, rest: o.rotation.z };
        if (o.isBone && o.name === "RightHand") actor.wingR = { bone: o, rest: o.rotation.z };
      });
    }
    scene.add(root);
    actors.add(actor);
    return actor;
  }

  // ---------------------------------------------------------------------------
  // Feet on the snow: body tilt plus CCD leg IK (three's CCDIKSolver) for the fox and deer.
  //
  // The animations were made on flat ground. Each frame, after the clip poses the legs, the
  // body is pitched and rolled to the slope under its feet, then each foot is moved to the
  // same height above the *real* snow that it had above the flat ground in the clip, and the
  // solver bends that leg's upper and lower bones to reach it.

  // Feet settle a little into the snow (less for small animals).
  const snowSink = (spec) => Math.min(0.03, 0.015 * spec.length);
  const _v = new THREE.Vector3();

  function rigLegs(actor, model, chains) {
    const nodes = {};
    model.traverse((o) => { nodes[o.name] = o; });
    model.updateMatrixWorld(true);
    actor.legs = [];
    for (const chain of chains) {
      const upper = nodes[chain.upper], lower = nodes[chain.lower], ik = nodes[chain.foot];
      if (!upper || !lower || !ik) continue;
      // Foot tip (the rig's foot control or helper), in the lower leg's space.
      const tip = new THREE.Object3D();
      lower.add(tip);
      tip.position.copy(lower.worldToLocal(ik.getWorldPosition(_v)));
      const target = new THREE.Object3D(); // only its matrixWorld is read; set directly
      target.matrixAutoUpdate = false;
      // The solver only needs a bone list: [links..., effector, target].
      const solver = new CCDIKSolver({ skeleton: { bones: [upper, lower, tip, target] } }, [
        { target: 3, effector: 2, links: [{ index: 1 }, { index: 0 }], iteration: 2, maxAngle: 0.35 },
      ]);
      // contact: the foot's lowest height in the clips so far (the tip sits a little above the sole).
      // Upper first, so each hinge correction sees its parent's final pose.
      const linkBones = [upper, lower];
      actor.legs.push({
        front: chain.front, left: actor.holder.worldToLocal(ik.getWorldPosition(_v)).x > 0, tip, target, solver, linkBones,
        posed: linkBones.map(() => new THREE.Quaternion()), delta: linkBones.map(() => new THREE.Quaternion()), axis: new THREE.Vector3(),
        animH: 0, contact: Infinity, lift: 0,
      });
    }
    // Footprint: where the front, back, left and right feet stand in the rest pose. The body's
    // tilt and height come from the snow under these fixed points, not under the moving feet,
    // which would rock the body with every step.
    const avg = (f, k) => { const ls = actor.legs.filter(f); return ls.reduce((s, l) => s + actor.holder.worldToLocal(l.tip.getWorldPosition(_v))[k], 0) / ls.length; };
    actor.foot = { fz: avg((l) => l.front, "z"), bz: avg((l) => !l.front, "z"), lx: avg((l) => l.left, "x"), rx: avg((l) => !l.left, "x") };
    actor.pitch = 0;
    actor.roll = 0;
  }

  // Kept cheap for phones: one skeleton update per animal per frame (the body tilt and height
  // found this frame are applied on the next, which smoothing hides), feet already within
  // IK_TOLERANCE are skipped, and the solver runs in short batches until the foot is there.
  const IK_TOLERANCE = 0.008;
  const IK_BATCHES = innerWidth < 560 ? 3 : 5; // 2 CCD iterations per batch
  // The solver starts from the clip's pose every frame, so its answer can jump (a foot unlocking,
  // a knee hitting its limit). Each bone's correction may change only this fast, in radians per
  // second (faster for quick small animals: SPECIES ikRate), which smooths the jumps without
  // lagging normal tracking.
  const IK_RATE = 5;
  const _tq = new THREE.Quaternion();
  const _inv = new THREE.Matrix4();
  const _p = new THREE.Vector3();

  // Localhost: ?ikdiag=1 records, per leg link, the IK's change as swing (bending) vs twist
  // (rotation about the bone's own length), which pinches a skinned limb.
  const ikDiag = local && params.get("ikdiag") === "1" ? {} : null;
  const _d = new THREE.Quaternion(), _axis = new THREE.Vector3();
  function recordTwist(a, leg) {
    leg.linkBones.forEach((bone, i) => {
      _d.copy(leg.before[i]).invert().multiply(bone.quaternion); // change in the bone's local frame
      const child = bone.children.find((c) => c.isBone) || leg.tip;
      _axis.copy(child.position).normalize(); // the bone's length direction
      const proj = _d.x * _axis.x + _d.y * _axis.y + _d.z * _axis.z;
      const twist = Math.abs(2 * Math.atan2(Math.abs(proj), _d.w));
      const total = 2 * Math.acos(Math.min(1, Math.abs(_d.w)));
      const key = `${a.name} ${leg.front ? "front" : "back"} ${["upper", "lower"][i]}`;
      const r = (ikDiag[key] ||= { n: 0, twistMax: 0, twistSum: 0, totalMax: 0 });
      r.n++; r.twistMax = Math.max(r.twistMax, twist); r.twistSum += twist; r.totalMax = Math.max(r.totalMax, total);
    });
  }

  // CCD bends joints in whatever direction reaches the target fastest, which can fold a knee
  // forward or out sideways (from the side that reads as a thin, broken leg). After each pass,
  // keep only each bone's bend in the leg's plane as the clip poses it (hip, knee, foot), capped
  // at HINGE_LIMIT beyond what the clip already does. A nearly straight leg has no clear plane;
  // it bends about the animal's left-right axis.
  const HINGE_LIMIT = 0.6; // radians, about 35 degrees
  const _hq = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _bq = new THREE.Quaternion();
  const _hAxis = new THREE.Vector3(), _scratch = new THREE.Vector3(), _thigh = new THREE.Vector3(), _shin = new THREE.Vector3();
  function legPlane(a, leg) {
    const [upper, lower] = leg.linkBones;
    _scratch.setFromMatrixPosition(upper.matrixWorld);
    _thigh.setFromMatrixPosition(lower.matrixWorld).sub(_scratch);
    _shin.setFromMatrixPosition(leg.tip.matrixWorld);
    _shin.sub(_scratch.setFromMatrixPosition(lower.matrixWorld));
    leg.axis.crossVectors(_thigh, _shin);
    if (leg.axis.lengthSq() > 0.02 * _thigh.lengthSq() * _shin.lengthSq()) leg.axis.normalize(); // bent more than ~8 degrees
    else leg.axis.set(1, 0, 0).applyQuaternion(a.holder.getWorldQuaternion(_hq));
  }
  function constrainToHinge(a, leg) {
    leg.linkBones.forEach((bone, i) => {
      // The change CCD made, in the bone's own frame (relative to the clip's pose).
      _d.copy(leg.posed[i]).invert().multiply(bone.quaternion);
      // The hinge axis in that same frame.
      bone.parent.matrixWorld.decompose(_scratch, _pq, _scratch);
      _bq.copy(_pq).multiply(leg.posed[i]).invert();
      _hAxis.copy(leg.axis).applyQuaternion(_bq);
      const proj = _d.x * _hAxis.x + _d.y * _hAxis.y + _d.z * _hAxis.z;
      let angle = 2 * Math.atan2(proj, _d.w);
      if (angle > Math.PI) angle -= Math.PI * 2;
      angle = Math.max(-HINGE_LIMIT, Math.min(HINGE_LIMIT, angle));
      _d.setFromAxisAngle(_hAxis, angle);
      bone.quaternion.copy(leg.posed[i]).multiply(_d);
      bone.updateMatrixWorld(true);
    });
  }

  // The mixer only writes a bone when the clip's value changes, so a held pose (a planted foot,
  // a grazing deer) would keep last frame's IK and the corrections would pile up. Put the clip's
  // pose back before the mixer runs.
  function unbendLegs(a) {
    for (const leg of a.legs || []) {
      if (!leg.bent) continue;
      leg.linkBones.forEach((b, i) => b.quaternion.copy(leg.posed[i]));
      leg.bent = false;
    }
  }

  function solveLegs(a, dt) {
    if (!a.legs?.length || a.climbing || a.carried) return;
    const { root, holder } = a;
    // Pose from the clip, with last frame's tilt and body height.
    a.bodyY ??= heightAt(a.x, a.z);
    root.position.y = a.bodyY + a.lift;
    holder.rotation.set(a.pitch, 0, a.roll);
    root.updateMatrixWorld(true);
    _inv.copy(holder.matrixWorld).invert();

    // Each foot's height above the clip's flat ground, in the model's own (untilted) space.
    for (const leg of a.legs) {
      _v.setFromMatrixPosition(leg.tip.matrixWorld);
      _p.copy(_v).applyMatrix4(_inv);
      leg.contact = Math.min(leg.contact, _p.y);
      leg.animH = Math.max(0, _p.y - leg.contact);
      leg.lift = Math.max(leg.lift, leg.animH); // how high this foot steps in the clips so far
      leg.wx = _v.x;
      leg.wy = _v.y;
      leg.wz = _v.z;
    }

    // The snow under the footprint (root space has the heading but no tilt).
    const { fz, bz, lx, rx } = a.foot;
    const snow = (px, pz) => heightAt(_v.set(px, 0, pz).applyMatrix4(root.matrixWorld).x, _v.z);
    const fl = snow(lx, fz), fr = snow(rx, fz), bl = snow(lx, bz), br = snow(rx, bz);
    const front = (fl + fr) / 2, back = (bl + br) / 2, left = (fl + bl) / 2, right = (fr + br) / 2;

    // Tilt for next frame (smoothed; the lag is invisible).
    const k = Math.min(1, dt * 8);
    a.pitch += (-Math.atan2(front - back, Math.max(0.3, fz - bz)) - a.pitch) * k;
    a.roll += (Math.atan2(left - right, Math.max(0.2, lx - rx)) - a.roll) * k;
    // Body height this frame: rest on the snow under the feet, crouching a little toward the
    // lowest foot so the legs can reach. Applied by shifting the IK targets the opposite way,
    // which saves a second skeleton update; the root moves after solving.
    const mean = (front + back) / 2;
    const lowest = Math.min(fl, fr, bl, br);
    const usedY = a.bodyY;
    a.bodyY += (mean - (mean - lowest) * 0.5 - a.bodyY) * Math.min(1, dt * 12);
    const dy = a.bodyY - usedY;
    root.position.y = a.bodyY + a.lift; // takes effect at render; targets below are shifted by -dy

    // Off screen: the tilt is enough.
    if (Math.abs(a.x) > 1.05 * halfWidthAt(a.z)) {
      for (const leg of a.legs) { leg.locked = false; leg.lockX = leg.lockZ = undefined; leg.slipX = leg.slipZ = 0; for (const q of leg.delta) q.identity(); }
      return;
    }

    const spec = SPECIES[a.name];
    const SLIP_TIME = 0.22; // seconds for a released foot to ease back to the clip's pose
    for (const leg of a.legs) {
      // Foot locking: a foot the clip has planted stays pinned to its spot on the snow while the
      // body moves or turns over it, until the clip lifts it (then it eases back to the pose,
      // starting and ending at rest so the foot never jerks).
      let x = leg.wx, z = leg.wz;
      if (leg.slipX) {
        leg.slipT += dt / SLIP_TIME;
        const t = Math.min(1, leg.slipT), f = 1 - t * t * (3 - 2 * t);
        x += leg.slipX * f;
        z += leg.slipZ * f;
        if (t >= 1) leg.slipX = leg.slipZ = 0;
      }
      // Planted: near the bottom of its step (small animals barely lift their feet).
      if (leg.animH < Math.min(0.02 * spec.length, 0.15 * leg.lift)) {
        if (!leg.locked) { leg.locked = true; leg.lockX = x; leg.lockZ = z; leg.slipX = leg.slipZ = 0; }
        // About to over-stretch: let go.
        if (Math.hypot(leg.lockX - leg.wx, leg.lockZ - leg.wz) > 0.16 * spec.length) leg.locked = false;
      } else leg.locked = false;
      if (leg.locked) { x = leg.lockX; z = leg.lockZ; }
      else if (leg.lockX !== undefined) {
        // Just released: ease from the pinned spot back to the clip's pose.
        leg.slipX = leg.lockX - leg.wx;
        leg.slipZ = leg.lockZ - leg.wz;
        leg.slipT = 0;
        leg.lockX = leg.lockZ = undefined;
        x = leg.wx + leg.slipX;
        z = leg.wz + leg.slipZ;
      }
      const ty = heightAt(x, z) + leg.contact + leg.animH - snowSink(spec) - dy;
      const settled = !leg.locked && !leg.slipX && Math.abs(leg.wy - ty) < IK_TOLERANCE;
      if (settled && leg.delta.every((q) => q.w > 0.99999)) continue;
      leg.linkBones.forEach((b, i) => leg.posed[i].copy(b.quaternion)); // the clip's pose
      if (!settled) {
        leg.target.matrixWorld.makeTranslation(x, ty, z);
        legPlane(a, leg);
        if (ikDiag) leg.before = leg.linkBones.map((b) => b.quaternion.clone());
        for (let b = 0; b < IK_BATCHES; b++) {
          leg.solver.update();
          constrainToHinge(a, leg);
          _v.setFromMatrixPosition(leg.tip.matrixWorld);
          if (Math.abs(_v.y - ty) + Math.abs(_v.x - x) + Math.abs(_v.z - z) < IK_TOLERANCE * 1.5) break;
        }
        if (ikStats) (ikStats.resid ||= []).push(Math.hypot(_v.x - x, _v.y - ty, _v.z - z));
        if (ikDiag) recordTwist(a, leg);
      }
      // Ease each bone's correction toward the new answer (none, when the foot is already there).
      leg.linkBones.forEach((b, i) => {
        if (settled) _tq.identity();
        else _tq.copy(leg.posed[i]).invert().multiply(b.quaternion);
        if (ikStats) ikStats.jump = Math.max(ikStats.jump || 0, leg.delta[i].angleTo(_tq));
        leg.delta[i].rotateTowards(_tq, (spec.ikRate ?? IK_RATE) * dt);
        b.quaternion.copy(leg.posed[i]).multiply(leg.delta[i]).normalize();
      });
      leg.bent = true;
    }
  }

  // The three.js parrot is vertex-coloured; remap its colours by brightness, to cardinal reds
  // or owl browns. (Linear colour space values.)
  const TINTS = {
    cardinal: (l) => [0.32 + 0.3 * l, 0.012 + 0.02 * l, 0.018 + 0.02 * l],
    owl: (l) => [0.1 + 0.24 * l, 0.075 + 0.18 * l, 0.055 + 0.12 * l],
  };
  function tint(mesh, name) {
    const c = mesh.geometry.attributes.color;
    if (!c) return;
    mesh.geometry = mesh.geometry.clone();
    const col = mesh.geometry.attributes.color;
    for (let i = 0; i < col.count; i++) {
      const l = 0.3 * col.getX(i) + 0.59 * col.getY(i) + 0.11 * col.getZ(i);
      col.setXYZ(i, ...TINTS[name](l));
    }
    col.needsUpdate = true;
  }

  function remove(actor) {
    if (!actor) return;
    scene.remove(actor.root);
    actor.mixer?.stopAllAction();
    actor.root.traverse((o) => o.isMesh && o.material.dispose());
    actors.delete(actor);
  }

  function play(actor, clip, { fade = SPECIES[actor.name].fade ?? 0.35, speed = 1 } = {}) {
    const next = actor.actions[clip];
    if (!next || actor.current === next) return;
    next.reset().setEffectiveTimeScale(speed).setEffectiveWeight(1).fadeIn(fade).play();
    actor.current?.fadeOut(fade);
    actor.current = next;
  }

  function place(actor, x, z, heading = actor.heading) {
    actor.x = x;
    actor.z = z;
    actor.heading = heading;
    actor.root.position.set(x, heightAt(x, z) + actor.lift, z);
    actor.root.rotation.y = heading;
  }

  // Heading that faces from (x, z) toward (tx, tz). Models face +Z at heading 0.
  const headingTo = (a, tx, tz) => Math.atan2(tx - a.x, tz - a.z);
  // Shortest signed angle from one heading to another, in (-PI, PI].
  const angleDiff = (from, to) => ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const turnToward = (from, to, maxStep) => from + Math.max(-maxStep, Math.min(maxStep, angleDiff(from, to)));

  // ---------------------------------------------------------------------------
  // Movement helpers (generators: yield a number to wait that many seconds, yield nothing to
  // wait one frame; the frame's dt comes back from each yield). Walks return false if their
  // `until` condition interrupted them.

  // One step of locomotion toward (tx, tz); returns the remaining distance.
  // Animals with a turning radius (fox, deer) always move along their heading and steer toward
  // the goal at a limited rate, slowing into tight turns, so they walk in arcs rather than
  // spinning on the spot. Close goals get a tighter radius, so they're always reachable. The
  // walk or run clip plays at the actual pace, which keeps feet from skating.
  function stepToward(a, tx, tz, speed, dt, nominal) {
    const dx = tx - a.x, dz = tz - a.z;
    const dist = Math.hypot(dx, dz);
    const spec = SPECIES[a.name];
    if (!spec.turnRadius) {
      const step = Math.min(dist, speed * dt);
      if (dist > 1e-6) place(a, a.x + (dx / dist) * step, a.z + (dz / dist) * step, turnToward(a.heading, Math.atan2(dx, dz), dt * 5));
      return dist - step;
    }
    const walk = SPEED[a.name]?.walk || speed;
    const r = Math.min(spec.turnRadius * Math.max(1, speed / walk), Math.max(0.3, dist * 0.5));
    const off = angleDiff(a.heading, Math.atan2(dx, dz));
    const pace = speed * Math.max(0.3, Math.cos(off));
    const turn = (pace / r) * dt;
    a.heading += Math.max(-turn, Math.min(turn, off));
    const step = Math.min(dist, pace * dt);
    place(a, a.x + Math.sin(a.heading) * step, a.z + Math.cos(a.heading) * step, a.heading);
    if (nominal) a.current?.setEffectiveTimeScale(Math.max(0.35, Math.min(spec.maxRate ?? 1.8, pace / nominal)));
    return Math.hypot(tx - a.x, tz - a.z);
  }

  // Which speed a clip was animated for, so its playback can follow the real pace.
  const clipPace = (a, clip) => (clip === "Gallop" || clip === "move" ? SPEED[a.name]?.run : clip === "Walk" ? SPEED[a.name]?.walk : null);

  function* walkTo(a, tx, tz, { speed, clip, until }) {
    if (clip) play(a, clip, { speed: 1 });
    const nominal = clipPace(a, clip || a.current?.getClip().name);
    let ok = true;
    const arrive = SPECIES[a.name].turnRadius ? 0.25 : 0.05;
    for (;;) {
      if (until && until()) { ok = false; break; }
      const dt = yield;
      // Sub-steps of at most 0.25 units, so a slow frame (or fast-forward) can't overshoot
      // the goal and leave the animal circling it at its turning radius.
      const n = Math.max(1, Math.ceil((speed * dt) / 0.25));
      let left = Infinity;
      for (let i = 0; i < n && left >= arrive; i++) left = stepToward(a, tx, tz, speed, dt / n, nominal);
      if (left < arrive) break;
    }
    if (a.current) a.current.setEffectiveTimeScale(1);
    return ok;
  }

  // Follow a moving target until within `stop`, or interrupted.
  function* chase(a, target, { speed, clip, stop, until }) {
    if (clip) play(a, clip);
    const nominal = clipPace(a, clip);
    for (;;) {
      if (target.gone || (until && until())) return false;
      if (Math.hypot(target.x - a.x, target.z - a.z) <= stop) return true;
      const dt = yield;
      const n = Math.max(1, Math.ceil((speed * dt) / 0.25));
      for (let i = 0; i < n; i++) stepToward(a, target.x, target.z, speed, dt / n, nominal);
    }
  }

  function* turnTo(a, heading) {
    // Animals with a turning radius walk round in a small arc instead of spinning in place.
    if (SPECIES[a.name].turnRadius) {
      const r = SPECIES[a.name].turnRadius;
      return yield* walkTo(a, a.x + Math.sin(heading) * r * 1.5, a.z + Math.cos(heading) * r * 1.5, { speed: (SPEED[a.name]?.walk || 1) * 0.8, clip: "Walk" });
    }
    // Compare directions, not raw angles: 90° and 450° are the same heading.
    while (Math.abs(angleDiff(a.heading, heading)) > 0.02) {
      const dt = yield;
      place(a, a.x, a.z, turnToward(a.heading, heading, dt * 3));
    }
  }

  // Wait, unless `until` becomes true first (returns false then).
  function* pause(seconds, until) {
    let t = seconds;
    while (t > 0) {
      if (until && until()) return false;
      t -= yield;
    }
    return true;
  }

  function* parallel(...gens) {
    const tasks = gens.map((g) => ({ g, wait: 0, done: false }));
    while (tasks.some((t) => !t.done)) {
      const dt = yield;
      for (const t of tasks) {
        if (t.done) continue;
        if (t.wait > 0) { t.wait -= dt; continue; }
        const r = t.g.next(dt);
        if (r.done) t.done = true;
        else if (typeof r.value === "number") t.wait = r.value;
      }
    }
  }

  // Flight along a gentle arc to a point in the air (birds, the owl).
  function* flyTo(a, tx, ty, tz, { speed, arc = 1.5, bank = 0 }) {
    const p = a.root.position;
    const sx = p.x, sy = p.y, sz = p.z;
    const dist = Math.hypot(tx - sx, ty - sy, tz - sz);
    const dur = Math.max(0.6, dist / speed);
    const heading = Math.atan2(tx - sx, tz - sz);
    let t = 0;
    while (t < dur) {
      const dt = yield;
      t += dt;
      const f = THREE.MathUtils.smootherstep(Math.min(1, t / dur), 0, 1);
      p.set(sx + (tx - sx) * f, sy + (ty - sy) * f + Math.sin(f * Math.PI) * arc, sz + (tz - sz) * f);
      a.x = p.x;
      a.z = p.z;
      a.heading = turnToward(a.heading, heading, dt * 6);
      a.root.rotation.y = a.heading;
      a.holder.rotation.z = Math.sin(f * Math.PI) * bank;
    }
    a.holder.rotation.z = 0;
  }

  // An owl's flight: bursts of deep wingbeats (quick downstroke, slower recovery) between
  // glides with the wings held out, body leaning into it. Clips are stopped so the wing bones
  // are ours; on arrival the wings fold back to rest.
  function* owlFlight(owl, tx, ty, tz) {
    owl.mixer?.stopAllAction();
    owl.current = null;
    let flying = true;
    const wings = (angle) => {
      if (owl.wingL) owl.wingL.bone.rotation.z = owl.wingL.rest + angle;
      if (owl.wingR) owl.wingR.bone.rotation.z = owl.wingR.rest - angle;
    };
    yield* parallel(
      (function* () {
        owl.holder.rotation.x = 0.3;
        yield* flyTo(owl, tx, ty, tz, { speed: 5.5, arc: 1.2, bank: 0.25 });
        flying = false;
      })(),
      (function* () {
        let t = 0, phase = 0, spread = 0;
        while (flying) {
          const dt = yield;
          t += dt;
          spread = Math.min(1, spread + dt * 4); // open the wings on take-off
          const beating = t % 2.2 < 1.4; // flap ~1.4 s, glide ~0.8 s
          phase += dt * Math.PI * 2 * (beating ? 2.6 : 0);
          // Asymmetric stroke: the downstroke is the faster half.
          const s = Math.sin(phase);
          const stroke = beating ? (s > 0 ? s : s * 0.7) : 0.15;
          wings(spread * (1.15 + 0.75 * stroke));
        }
        // Fold back over a third of a second.
        let fold = 1;
        const from = 1.15;
        while (fold > 0) {
          fold -= (yield) * 3;
          wings(Math.max(0, fold) * from);
        }
        wings(0);
        owl.holder.rotation.x = 0;
      })()
    );
  }

  // ---------------------------------------------------------------------------
  // The world the animals move in

  // The ground band the animals use: from just in front of the camera's view to mid-field,
  // across the visible width. Spawn and exit points sit beyond the screen edges.
  const Z_NEAR = -3, Z_FAR = -46;
  const visibleX = (z) => 0.95 * halfWidthAt(z);
  const inArea = (x, z) => z <= Z_NEAR && z >= Z_FAR && Math.abs(x) <= visibleX(z);
  const offscreenPoint = (side = pick([-1, 1]), z = rnd(Z_FAR + 6, Z_NEAR - 2)) => ({ x: side * 1.3 * halfWidthAt(z), z, side });

  // Things to walk around: tree trunks (and the lower pine boughs) and the snowman.
  const obstacles = trees.filter((t) => t.z > -70).map((t) => ({ x: t.x, z: t.z, r: t.kind === "pine" ? t.h * 0.3 : 0.7 }));
  const climbable = trees.filter((t) => t.z <= Z_NEAR && t.z >= Z_FAR - 6 && Math.abs(t.x) < 1.05 * halfWidthAt(t.z));

  function blockedBy(x0, z0, x1, z1, pad = 0.5) {
    const dx = x1 - x0, dz = z1 - z0, len2 = dx * dx + dz * dz || 1;
    for (const o of obstacles) {
      if (Math.hypot(o.x - x0, o.z - z0) < o.r + pad) continue; // starting inside: let it walk out
      const t = Math.max(0, Math.min(1, ((o.x - x0) * dx + (o.z - z0) * dz) / len2));
      if (Math.hypot(x0 + dx * t - o.x, z0 + dz * t - o.z) < o.r + pad) return o;
    }
    return null;
  }
  const clearOf = (x, z, pad = 0.8) => obstacles.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + pad);

  // A random reachable spot in the area, `min`–`max` away from (x, z).
  function randomSpot(x, z, min, max) {
    for (let i = 0; i < 30; i++) {
      const ang = rnd(0, Math.PI * 2), d = rnd(min, max);
      const sx = x + Math.cos(ang) * d, sz = z + Math.sin(ang) * d;
      if (inArea(sx, sz) && clearOf(sx, sz) && !blockedBy(x, z, sx, sz)) return { x: sx, z: sz };
    }
    for (let i = 0; i < 30; i++) {
      const sz = rnd(Z_FAR, Z_NEAR), sx = rnd(-1, 1) * visibleX(sz);
      if (clearOf(sx, sz)) return { x: sx, z: sz };
    }
    return { x: 0, z: (Z_NEAR + Z_FAR) / 2 };
  }

  // Walk to a point, stepping around an obstacle if one is in the way.
  function* travel(a, tx, tz, opts) {
    const o = blockedBy(a.x, a.z, tx, tz);
    if (o) {
      const dx = tx - a.x, dz = tz - a.z, len = Math.hypot(dx, dz) || 1;
      let px = -dz / len, pz = dx / len; // perpendicular
      if ((o.x - a.x) * px + (o.z - a.z) * pz > 0) { px = -px; pz = -pz; } // pass on the far side
      const wx = o.x + px * (o.r + 1.4), wz = o.z + pz * (o.r + 1.4);
      if (!(yield* walkTo(a, wx, wz, opts))) return false;
    }
    return yield* walkTo(a, tx, tz, opts);
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const live = (name) => [...actors].filter((a) => a.name === name && !a.gone);
  const nearest = (from, list) => list.reduce((best, a) => (!best || dist(from, a) < dist(from, best) ? a : best), null);

  // Perches: tree tops, the fronts of pine boughs, frosted crowns, the snowman's hat.
  function perches({ boughs = false, snowmanHat = false } = {}) {
    const out = [];
    for (const t of trees) {
      if (t.z > 0 || t.z < -75 || Math.abs(t.x) > halfWidthAt(t.z)) continue;
      const g = heightAt(t.x, t.z);
      if (t.kind === "pine") {
        out.push({ x: t.x, y: g - 0.2 + t.h * 1.1, z: t.z, kind: "top", tree: t });
        if (boughs)
          for (const tier of [1, 2]) {
            const f = tier / 4, r = t.h * (0.36 - f * 0.25);
            const y = g - 0.2 + t.h * 0.12 + f * t.h * 0.66 + t.h * 0.32 * 0.45;
            out.push({ x: t.x, y, z: t.z + r * 0.72, kind: "bough", tree: t });
          }
      } else {
        out.push({ x: t.x, y: g - 0.1 + t.h * 0.98, z: t.z, kind: "top", tree: t });
      }
    }
    if (snowmanHat && snowman) out.push({ x: snowman.x, y: heightAt(snowman.x, snowman.z) + snowman.top + 0.05, z: snowman.z, kind: "hat" });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Behaviours. Each animal's brain picks its own destinations and reacts to the others.

  // Runs fn(k) with k going 0 -> 1 (eased) over the given seconds.
  function* tween(seconds, fn) {
    let t = 0;
    for (;;) {
      const k = Math.min(1, t / seconds);
      fn(k * k * (3 - 2 * k));
      if (k >= 1) return;
      t += yield;
    }
  }

  // A trunk's radius at height y above its base (landscape.js: frosted trees taper from 0.05h to
  // 0.03h over 0.5h, pines from 0.05h to 0.035h over 0.2h, starting 0.02h below the snow).
  function trunkRadius(tree, y) {
    const h = tree.h;
    return tree.kind === "frost"
      ? h * (0.05 - 0.02 * Math.min(1, y / (h * 0.5)))
      : h * (0.05 - 0.015 * Math.min(1, (y + h * 0.02) / (h * 0.2)));
  }

  function* climb(sq, tree, dir) {
    // On the side of the trunk facing the camera, belly to the bark: up facing the trunk,
    // down head-first like a real squirrel. Leg IK and tilt pause while it's on the trunk.
    const base = heightAt(tree.x, tree.z);
    const height = tree.kind === "frost" ? tree.h * 0.42 : tree.h * 0.1;
    const x = tree.x;
    const bark = (y) => tree.z + trunkRadius(tree, y) + 0.03; // z of the bark at height y
    const clear = SPECIES.squirrel.length * 0.5; // on the snow, its body center stands this far out
    const up = dir === "up";
    sq.climbing = true;
    play(sq, "move");
    if (up) {
      // Turn to the trunk, then step in and tip up onto it.
      const h0 = sq.heading, x0 = sq.root.position.x, z0 = sq.root.position.z;
      const turn = angleDiff(h0, Math.PI);
      yield* tween(0.15 + Math.abs(turn) * 0.08, (k) => { sq.root.rotation.y = h0 + turn * k; });
      yield* tween(0.18, (k) => {
        sq.root.position.set(x0 + (x - x0) * k, base, z0 + (bark(0) - z0) * k);
        sq.holder.rotation.set(-k * Math.PI / 2, 0, 0);
      });
    } else {
      sq.root.position.set(x, base + height, bark(height));
      sq.root.rotation.set(0, 0, 0);
      sq.holder.rotation.set(Math.PI / 2, 0, 0);
      yield* fade(sq, 0, 1, 0.3);
    }
    sq.current.setEffectiveTimeScale(1.4);
    const from = up ? 0 : height, to = up ? height : 0;
    yield* tween(height / 1.6, (k) => {
      const y = from + (to - from) * k;
      sq.root.position.set(x, base + y, bark(y));
    });
    sq.grounded = !up;
    if (up) {
      yield* fade(sq, 1, 0, 0.4); // slips into the branches
    } else {
      // Tip forward off the trunk onto the snow, facing the camera, stepping clear of it.
      yield* tween(0.2, (k) => {
        sq.holder.rotation.set((1 - k) * Math.PI / 2, 0, 0);
        sq.root.position.set(x, base, bark(0) + clear * k);
      });
    }
    sq.x = x;
    sq.z = up ? bark(0) : bark(0) + clear;
    sq.holder.rotation.set(0, 0, 0);
    sq.heading = up ? Math.PI : 0;
    sq.root.rotation.y = sq.heading;
    sq.pitch = sq.roll = 0;
    sq.bodyY = undefined; // re-seat on the snow
    sq.climbing = up; // hidden up in the tree: keep IK off until it comes down
  }



  function* lookAround(sq, seconds, until) {
    // Sit up (the idle clip) and glance to one side.
    play(sq, "idle2");
    const glance = sq.heading + pick([-1, 1]) * rnd(0.3, 0.8);
    let t = 0;
    while (t < seconds) {
      if (until && until()) return false;
      const dt = yield;
      t += dt;
      if (t > 0.2) place(sq, sq.x, sq.z, turnToward(sq.heading, glance, dt * 4));
    }
    return true;
  }


  // Squirrels move in quick bursts with pauses, like the real thing.
  function* scamper(sq, tx, tz, until, speed = 2.4) {
    for (;;) {
      const d = Math.hypot(tx - sq.x, tz - sq.z);
      if (d < 0.1) return true;
      const step = Math.min(d, rnd(1.6, 3.4));
      const f = step / d;
      if (!(yield* walkTo(sq, sq.x + (tx - sq.x) * f, sq.z + (tz - sq.z) * f, { speed, clip: "move", until }))) return false;
      if (d - step > 0.1 && !(yield* lookAround(sq, rnd(0.25, 0.8), until))) return false;
    }
  }

  // Where a squirrel stands on the snow in front of a trunk, ready to climb it.
  const trunkFront = (t) => ({ x: t.x, z: t.z + trunkRadius(t, 0) + 0.03 + SPECIES.squirrel.length * 0.5 });

  // The fox has the squirrel: a fresh copy hangs limp across its jaws (following the head bone
  // after each frame's pose) while the fox lopes off-screen.
  function* carryOff(fox, foxAgent, prey) {
    end(prey);
    const carried = make("squirrel");
    if (!carried) return;
    carried.carried = true;
    if (carried.shadow) carried.shadow.visible = false;
    play(carried, "move", { fade: 0 });
    carried.current.time = 0.12; // legs stretched out
    carried.current.setEffectiveTimeScale(0);
    foxAgent.extras.push(carried);
    // Its middle in its own (unturned) space, in the limp pose, so that's what goes in the jaws.
    carried.holder.rotation.set(0.25, 0, 2.2); // rolled onto its back, drooping
    carried.root.position.set(0, 0, 0);
    carried.root.rotation.set(0, 0, 0);
    carried.mixer.update(0);
    carried.root.updateMatrixWorld(true);
    const middle = new THREE.Vector3();
    carried.root.traverse((o) => { if (o.isSkinnedMesh) { o.computeBoundingBox(); o.boundingBox.getCenter(middle).applyMatrix4(o.matrixWorld); } });
    const head = fox.head, mouth = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
    carried.follow = () => {
      // Jaws: a little ahead of and below the fox's head bone.
      head.getWorldPosition(mouth);
      const fwd = SPECIES.fox.length * 0.11;
      mouth.x += Math.sin(fox.heading) * fwd;
      mouth.z += Math.cos(fox.heading) * fwd;
      mouth.y -= SPECIES.fox.length * 0.1;
      const yaw = fox.heading + Math.PI / 2; // crosswise
      carried.root.rotation.set(0, yaw, 0);
      carried.root.position.copy(mouth).sub(_v.copy(middle).applyAxisAngle(yAxis, yaw));
    };
    carried.follow();
    play(fox, "Idle_2", { fade: 0.15 });
    yield 0.5;
    const exit = offscreenPoint(Math.sign(fox.x) || 1, fox.z);
    yield* travel(fox, exit.x, exit.z, { speed: SPEED.fox.run * 0.7, clip: "Gallop" });
  }
  const agentOf = (actor) => [...agents].find((a) => a.actors.includes(actor));

  const BRAINS = {
    // Comes down a tree, forages around, sometimes dashes to another tree, and runs for the
    // nearest tree whenever a fox gets close.
    *squirrel(sq) {
      let home = pick(climbable);
      yield* climb(sq, home, "down");
      const threat = () => live("fox").some((f) => dist(f, sq) < (f.pouncing ? 10 : 4));
      let actions = Math.floor(rnd(4, 9));
      while (actions-- > 0) {
        if (threat()) {
          // Flee: nearest tree, up the trunk, wait for the coast to clear.
          home = nearest(sq, climbable);
          const spot = trunkFront(home);
          yield* walkTo(sq, spot.x, spot.z, { speed: 3.5, clip: "move" });
          yield* climb(sq, home, "up");
          yield* pause(rnd(3, 6));
          let waited = 0;
          while (live("fox").some((f) => dist(f, sq) < 12) && waited < 15) waited += yield;
          if (Math.random() < 0.5) return; // stays hidden in the branches
          yield* climb(sq, home, "down");
          continue;
        }
        if (Math.random() < 0.3 && climbable.length > 1) {
          // Dash to another tree, anywhere in view, and pop up it for a moment.
          home = pick(climbable.filter((t) => t !== home));
          const spot = trunkFront(home);
          if (!(yield* scamper(sq, spot.x, spot.z, threat, 2.8))) continue;
          yield* climb(sq, home, "up");
          yield* pause(rnd(2, 4));
          if (Math.random() < 0.35) return;
          yield* climb(sq, home, "down");
        } else {
          const near = trunkFront(home);
          const spot = randomSpot(near.x, near.z, 1.5, 6);
          if (!(yield* scamper(sq, spot.x, spot.z, threat))) continue;
          yield* lookAround(sq, rnd(0.8, 2), threat);
        }
      }
      // Done foraging: back up the nearest tree.
      home = nearest(sq, climbable);
      const spot = trunkFront(home);
      yield* scamper(sq, spot.x, spot.z, null, 2.8);
      yield* climb(sq, home, "up");
    },

    // Roams and sniffs; stalks and pounces on any squirrel it spots on the ground.
    *fox(fox, agent) {
      const entry = offscreenPoint();
      place(fox, entry.x, entry.z, entry.side > 0 ? -Math.PI / 2 : Math.PI / 2);
      const leaveAt = rnd(40, 60);
      let calmUntil = 0;
      const prey = () => (agent.age > calmUntil ? nearest(fox, live("squirrel").filter((s) => s.grounded && dist(s, fox) < 30)) : null);
      let first = true;
      while (agent.age < leaveAt) {
        const target = prey();
        if (target) {
          // Stalk low and slow, then pounce. The squirrel usually notices the pounce in time.
          fox.hunting = true;
          // Trot in while far off, then creep for the last stretch.
          let close = yield* chase(fox, target, { speed: SPEED.fox.walk * 1.7, clip: "Walk", stop: 10, until: () => !target.grounded });
          if (close) close = yield* chase(fox, target, { speed: SPEED.fox.walk * 0.7, clip: "Walk", stop: 6.5, until: () => !target.grounded });
          if (close) {
            play(fox, "Idle_2_HeadLow", { fade: 0.2 });
            yield 0.6;
            // Now and then the squirrel doesn't notice: it freezes, and the fox carries it off.
            const prey = agentOf(target);
            if (prey && !target.gone && target.grounded && (CATCHES || Math.random() < CATCH_CHANCE)) {
              prey.wait = Infinity; // its brain stops; it just sits there
              play(target, "idle2");
              fox.pouncing = true;
              play(fox, "Gallop_Jump", { fade: 0.12 });
              // Close enough that the fox's jaws, not its chest, land on the squirrel.
              const caught = yield* chase(fox, target, { speed: SPEED.fox.run * 0.85, stop: SPECIES.fox.length * 0.42 });
              fox.pouncing = false;
              if (caught) {
                yield* carryOff(fox, agent, prey);
                return;
              }
              prey.wait = 0;
            }
            fox.pouncing = true;
            play(fox, "Gallop_Jump", { fade: 0.12 });
            const tx = target.x, tz = target.z;
            yield* walkTo(fox, tx, tz, { speed: SPEED.fox.run * 0.85 });
            fox.pouncing = false;
            play(fox, "Idle_2", { fade: 0.25 });
            yield rnd(1.5, 2.5);
            play(fox, "Eating"); // nose in the snow
            yield rnd(1.2, 2);
          }
          fox.hunting = false;
          calmUntil = agent.age + 8;
          continue;
        }
        const spot = first ? randomSpot(entry.side * visibleX(entry.z) * 0.6, entry.z, 0, 8) : randomSpot(fox.x, fox.z, 6, 16);
        first = false;
        if (!(yield* travel(fox, spot.x, spot.z, { speed: SPEED.fox.walk, clip: "Walk", until: () => !!prey() }))) continue;
        play(fox, Math.random() < 0.5 ? "Eating" : "Idle_2");
        yield* pause(rnd(1.5, 3), () => !!prey());
      }
      const exit = offscreenPoint();
      yield* travel(fox, exit.x, exit.z, { speed: SPEED.fox.walk * 1.6, clip: "Walk" });
    },

    // Wanders between grazing spots; bolts away from a fox.
    *deer(deer) {
      const entry = offscreenPoint();
      place(deer, entry.x, entry.z, entry.side > 0 ? -Math.PI / 2 : Math.PI / 2);
      const fear = () => live("fox").find((f) => dist(f, deer) < 9);
      let visits = Math.floor(rnd(2, 5));
      let spooked = false;
      while (visits-- > 0 && !spooked) {
        const spot = randomSpot(deer.x, deer.z, 5, 15);
        if (!(yield* travel(deer, spot.x, spot.z, { speed: SPEED.deer.walk, clip: "Walk", until: fear }))) { spooked = true; break; }
        play(deer, "Eating");
        if (!(yield* pause(rnd(4, 7), fear))) { spooked = true; break; }
        play(deer, pick(["Idle_2", "Idle_Headlow"]));
        if (!(yield* pause(rnd(1.5, 3), fear))) { spooked = true; break; }
      }
      if (spooked) {
        const fox = fear();
        const away = fox ? Math.sign(deer.x - fox.x) || 1 : pick([-1, 1]);
        const exit = offscreenPoint(away, deer.z);
        yield* travel(deer, exit.x, exit.z, { speed: SPEED.deer.run, clip: "Gallop" });
      } else {
        const exit = offscreenPoint();
        yield* travel(deer, exit.x, exit.z, { speed: SPEED.deer.walk, clip: "Walk" });
      }
    },

    // A little flock hopping between perches: tree tops, pine boughs and the snowman's hat.
    *birds(flock) {
      const entry = offscreenPoint();
      const flap = (b, k) => b.actions[Object.keys(b.actions)[0]]?.setEffectiveTimeScale(k);
      for (const b of flock) {
        b.actions[Object.keys(b.actions)[0]]?.play();
        flap(b, rnd(1.1, 1.4));
        b.root.position.set(entry.x + rnd(-2, 2), rnd(10, 14), entry.z + rnd(-2, 2));
        b.x = b.root.position.x;
        b.z = b.root.position.z;
      }
      let visits = Math.floor(rnd(1, 4));
      while (visits-- > 0) {
        const all = perches({ boughs: true, snowmanHat: true });
        const lead = pick(all);
        // Followers take the perches closest to the leader's.
        const spots = [lead, ...all.filter((p) => p !== lead).sort((a, b) => Math.hypot(a.x - lead.x, a.z - lead.z) - Math.hypot(b.x - lead.x, b.z - lead.z))];
        yield* parallel(
          ...flock.map((b, i) =>
            (function* () {
              yield rnd(0, 0.5);
              flap(b, rnd(1.2, 1.5));
              const s = spots[i % spots.length];
              yield* flyTo(b, s.x, s.y, s.z, { speed: rnd(6, 8), arc: rnd(1, 2.5) });
              flap(b, 0.12); // settled: an occasional slow flutter
              const face = rnd(-0.7, 0.7);
              let t = 0;
              const stay = rnd(3, 6);
              while (t < stay) {
                const dt = yield;
                t += dt;
                b.root.rotation.y += (face - b.root.rotation.y) * Math.min(1, dt * 3);
                b.holder.position.y = Math.abs(Math.sin(t * 3)) * 0.04;
              }
              b.heading = b.root.rotation.y;
            })()
          )
        );
      }
      const exit = offscreenPoint(-entry.side); // out the far side: across the screen, not back
      yield* parallel(...flock.map((b) => (function* () {
        flap(b, 1.4);
        yield rnd(0, 0.4);
        yield* flyTo(b, exit.x + rnd(-2, 2), rnd(11, 15), exit.z + rnd(-2, 2), { speed: 8, arc: 2 });
      })()));
    },

    // Night only: flies in to a tree top or bough, looks around, maybe moves to another tree,
    // then flies off — flapping its own wings in flight, folding them to perch.
    *owl(owl) {
      const entry = offscreenPoint();
      owl.root.position.set(entry.x, rnd(14, 18), entry.z);
      owl.x = entry.x;
      owl.z = entry.z;
      owl.heading = entry.side > 0 ? -Math.PI / 2 : Math.PI / 2;
      let stops = Math.random() < 0.45 ? 2 : 1;
      let last = null;
      while (stops-- > 0) {
        const p = pick(perches({ boughs: true }).filter((q) => q !== last && q.z > -55));
        last = p;
        yield* owlFlight(owl, p.x, p.y, p.z);
        // Perched: its own idle animation, facing out over the field, looking around.
        play(owl, "idle", { fade: 0.3 });
        let t = 0, target = rnd(-0.5, 0.5);
        const stay = rnd(10, 18);
        while (t < stay) {
          const dt = yield;
          t += dt;
          if (Math.random() < dt * 0.35) target = rnd(-0.9, 0.9);
          owl.heading += angleDiff(owl.heading, target) * Math.min(1, dt * 4);
          owl.root.rotation.y = owl.heading;
        }
      }
      const exit = offscreenPoint(-entry.side);
      yield* owlFlight(owl, exit.x, rnd(14, 18), exit.z);
    },
  };

  function* fade(actor, from, to, seconds) {
    const mats = [];
    actor.root.traverse((o) => o.isMesh && o !== actor.shadow && mats.push(o.material));
    mats.forEach((m) => { m.transparent = true; });
    let t = 0;
    do {
      const k = seconds ? Math.min(1, t / seconds) : 1;
      mats.forEach((m) => (m.opacity = from + (to - from) * k));
      if (k >= 1) break;
      t += yield;
    } while (true);
    if (to >= 1) mats.forEach((m) => { m.transparent = false; });
  }

  // Compile every animal's shaders up front (one hidden copy of each, under the ground), so the
  // first deer or owl to appear doesn't stall a frame.
  if (motion && renderer?.compileAsync) {
    const warm = Object.keys(sources).filter((n) => n !== "snowman").map(make).filter(Boolean);
    warm.forEach((a) => a.root.position.set(0, -60, 0));
    try {
      await renderer.compileAsync(scene, camera);
    } catch {}
    warm.forEach(remove);
  }

  // ---------------------------------------------------------------------------
  // The snowman stays put on the right, a little way back.

  let snowman = null;
  if (sources.snowman) {
    const s = make("snowman");
    actors.delete(s); // scenery, not an animal
    const z = -21;
    const x = 0.4 * halfWidthAt(z);
    place(s, x, z, -0.5);
    updateShadow(s);
    snowman = { x, z, top: SPECIES.snowman.height };
    obstacles.push({ x, z, r: 1.3 });
  }

  // ---------------------------------------------------------------------------
  // Director: decides who wanders in next. At most MAX_ANIMALS alive, at least one (a new one
  // arrives as soon as the last leaves), never a new one while a card is being read, and
  // nothing new for a species still cooling down.

  const KINDS = {
    deer: { day: 3, night: 3, cooldown: 20, max: 2, count: () => 1 },
    squirrel: { day: 3, night: 1, cooldown: 12, max: 3, count: () => 1 },
    fox: { day: 2, night: 2, cooldown: 30, max: 1, count: () => 1 },
    birds: { day: 2.5, night: 0.4, cooldown: 25, max: 1, count: () => 2 + Math.floor(rnd(0, 2)) },
    owl: { day: 0, night: 3, cooldown: 40, max: 1, count: () => 1 },
  };
  const SPECIES_OF = { birds: "bird" };

  const agents = new Set();
  const lastSpawn = {};
  let clock = 0;
  let nextAt = FIRST_SPAWN_AFTER;
  let lastTry = -Infinity;

  const animalsOnScreen = () => [...agents].reduce((n, a) => n + a.actors.length, 0);
  const aliveOf = (kind) => [...agents].filter((a) => a.kind === kind).length;

  function spawn(kind) {
    const t0 = performance.now();
    try {
      return spawnNow(kind);
    } finally {
      const ms = performance.now() - t0;
      if (local && ms > 8) console.warn(`Wildlife: spawning ${kind} took ${ms.toFixed(0)} ms`);
    }
  }

  function spawnNow(kind) {
    const k = KINDS[kind];
    const n = k.count();
    if (animalsOnScreen() + n > MAX_ANIMALS || aliveOf(kind) >= k.max) return false;
    const list = [];
    for (let i = 0; i < n; i++) {
      const a = make(SPECIES_OF[kind] || kind);
      if (a) list.push(a);
    }
    if (!list.length) return false;
    // `extras` are helper models (the owl's flying form) that don't count as more animals.
    const agent = { kind, actors: list, extras: [], wait: 0, age: 0 };
    agent.gen = kind === "birds" ? BRAINS.birds(list, agent) : BRAINS[kind](list[0], agent);
    // Run the brain up to its first wait now, so the animal is already at its entry point
    // (beyond the screen edge) before it's ever drawn.
    const first = agent.gen.next(0);
    if (first.done) { end(agent); return false; }
    if (typeof first.value === "number") agent.wait = first.value;
    agents.add(agent);
    lastSpawn[kind] = clock;
    return true;
  }

  function end(agent) {
    for (const a of [...agent.actors, ...agent.extras]) {
      a.gone = true;
      remove(a);
    }
    agents.delete(agent);
  }

  function choose() {
    const night = isNight();
    const squirrelOut = live("squirrel").some((s) => s.grounded);
    // With nobody around, cooldowns don't apply: there's always at least one animal.
    const empty = agents.size === 0;
    const options = Object.entries(KINDS).filter(([kind, k]) => {
      const w = night ? k.night : k.day;
      return w > 0 && (empty || clock - (lastSpawn[kind] ?? -1e9) >= k.cooldown) && aliveOf(kind) < k.max;
    });
    // A fox is much more likely to show up when there's a squirrel to stalk.
    const weight = ([kind, k]) => (night ? k.night : k.day) * (kind === "fox" && squirrelOut ? 3 : 1);
    let r = Math.random() * options.reduce((n, o) => n + weight(o), 0);
    for (const o of options) if ((r -= weight(o)) <= 0) return o[0];
    return null;
  }

  // Development: a lineup of every model in front of the camera, or a forced scene.
  if (FORCE === "lineup") {
    Object.keys(SPECIES).filter((n) => sources[n]).forEach((name, i, all) => {
      const a = make(name);
      a.mixer && play(a, Object.keys(a.actions).includes("Walk") ? "Walk" : Object.keys(a.actions)[0]);
      place(a, (i - (all.length - 1) / 2) * 2.6, 8, Math.PI / 2);
    });
    nextAt = Infinity;
  }
  // Localhost: how far planted feet sit from the snow (planted = within 0.04 of the ground in the clip).
  const ikStats = local ? { n: 0, sum: 0, max: 0, ms: 0, frames: 0, errs: [], worst: [], tilt: [], pops: [], popLog: [] } : null;
  function measureFeet(a) {
    if (a.climbing || a.carried || Math.abs(a.x) > 1.05 * halfWidthAt(a.z)) { for (const leg of a.legs) leg.prevTip = leg.prevVel = null; a.prevTilt = undefined; return; } // IK deliberately skipped
    a.root.updateMatrixWorld(true);
    // Smoothness: per-frame change of the body's tilt, and each foot's change of velocity (a pop).
    if (a.prevTilt !== undefined) ikStats.tilt.push(Math.abs(a.pitch + a.roll - a.prevTilt));
    a.prevTilt = a.pitch + a.roll;
    for (const leg of a.legs) {
      leg.tip.getWorldPosition(_v);
      const vel = leg.prevTip ? _v.clone().sub(leg.prevTip) : null;
      if (vel && leg.prevVel) {
        const pop = vel.distanceTo(leg.prevVel);
        ikStats.pops.push(pop);
        if (pop > 0.25 && ikStats.popLog.length < 12) ikStats.popLog.push({ pop: +pop.toFixed(2), who: a.name, clip: a.current?.getClip().name, locked: !!leg.locked, frame: ikStats.frames, dt: +ikStats.dt.toFixed(3), yaw: +a.root.rotation.y.toFixed(3), y: +a.root.position.y.toFixed(3) });
      }
      leg.prevTip = _v.clone();
      leg.prevVel = vel;
      if (!ikOn) {
        const h = _v.y - a.root.position.y; // flat-ground height, no IK
        leg.contact = Math.min(leg.contact, h);
        leg.animH = Math.max(0, h - leg.contact);
      }
      if (leg.animH > 0.015 * SPECIES[a.name].length) continue; // only feet that are planted in the clip
      const err = Math.abs(_v.y - (heightAt(_v.x, _v.z) + leg.contact - snowSink(SPECIES[a.name])));
      if (a.pitch === undefined) continue;
      ikStats.n++;
      ikStats.sum += err;
      ikStats.max = Math.max(ikStats.max, err);
      ikStats.errs.push(err);
      if (err > 0.08 && ikStats.worst.length < 12)
        ikStats.worst.push({ who: a.name, err: +err.toFixed(3), locked: !!leg.locked, front: leg.front, clip: a.current?.getClip().name, slope: +(a.pitch || 0).toFixed(2) });
    }
  }
  if (local) window.__wildlife = { actors, agents, spawn, ikStats, ikDiag };

  return {
    // Busy when anything is moving, so the landscape renders at full frame rate.
    get busy() {
      return agents.size > 0 || FORCE === "lineup";
    },
    update(dt) {
      if (!motion) return;
      dt = Math.min(dt, 0.1) * TIME_SCALE;
      clock += dt;
      if (ikStats) { ikStats.frames++; ikStats.dt = dt; }
      for (const agent of agents) {
        agent.age += dt;
        // Safety net: an animal that somehow lingers past two minutes is removed.
        if (agent.age > 120) {
          console.warn(`Wildlife: removed a stuck ${agent.kind}`);
          end(agent);
          continue;
        }
        if (agent.wait > 0) { agent.wait -= dt; continue; }
        const step = agent.gen.next(dt);
        if (step.done) end(agent);
        else if (typeof step.value === "number") agent.wait = step.value;
      }

      // Brains have moved everyone; now pose them, plant their feet, and drop their shadows.
      for (const a of actors) {
        unbendLegs(a);
        a.mixer?.update(dt);
        if (ikOn) {
          const t0 = ikStats ? performance.now() : 0;
          solveLegs(a, dt);
          if (ikStats && a.legs) ikStats.ms += performance.now() - t0;
        }
        updateShadow(a);
        if (ikStats && a.legs) measureFeet(a);
      }
      for (const a of actors) a.follow?.(); // things carried, placed after their carrier's pose

      const reading = document.body.classList.contains("is-reading");
      // Someone new every GAP seconds, or right away if the last animal just left.
      if ((clock >= nextAt || (agents.size === 0 && !FORCE && clock - lastTry > 1)) && !reading) {
        lastTry = clock;
        let kind = FORCE && FORCE !== "lineup" ? FORCE : choose();
        if (kind === "hunt") kind = aliveOf("squirrel") ? (aliveOf("fox") ? null : "fox") : "squirrel";
        const spawned = kind && KINDS[kind] && spawn(kind);
        nextAt = clock + (FORCE ? 3 : spawned ? rnd(...GAP) : 4);
      }
    },
  };
}
