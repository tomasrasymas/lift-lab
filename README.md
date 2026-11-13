# LiftLab: RC flight simulator

A browser-based RC flight simulator for learning to fly fixed-wing planes and quadcopters before flying for real. It works with a **RadioMaster Pocket** (or any EdgeTX/OpenTX radio) connected over USB.

## Run it

```bash
docker compose up -d --build
```

Open **http://localhost:8080** in Chrome, Edge or Firefox.

Development with hot reload:

```bash
docker compose --profile dev up liftlab-dev     # http://localhost:5173
# or without Docker: npm install && npm run dev
```

> The container only serves the web app. Your **browser** reads the radio directly through the Gamepad API, so no USB passthrough into Docker is needed (Docker Desktop on macOS can't pass USB devices through anyway).
> Use `localhost`: browsers only allow controller access on secure origins (https or localhost).

## Connect the RadioMaster Pocket

1. Turn the radio on and plug USB-C into the computer.
2. On the radio, pick **USB Joystick (HID)**.
3. Move a stick: browsers only reveal a controller after it sends input.

It works out of the box with the standard **Betaflight / EdgeTX layout**:

| Channel | Switch | Function |
|---|---|---|
| CH1–4 | sticks | Aileron, Elevator, Throttle, Rudder (AETR) |
| CH5 | SA | **ARM**: arms quads and the plane motor, only with the throttle low |
| CH6 | SB (3-pos) | Flight mode |
| CH7 | SC | Rates low / high |
| CH8 | SD | Reset aircraft |

A switch channel only becomes active the first time it reaches an end position, so channels you haven't set up on the radio never block arming. For any other layout, use **Menu → Controller → Run setup wizard**. Radio trims and expo work too, because the radio sends its mixed channel outputs.

## Aircraft

| Aircraft | What it teaches | Modes (3-pos switch) |
|---|---|---|
| **Trainer 1400**: high wing, tricycle gear | Basics, takeoff and landing, gentle stall | Manual / Gyro / Self-level |
| **FPV 5" Freestyle** | Acro flying, Betaflight "Actual" rates | Acro / Angle / Horizon |
| **Camera Drone** | GPS hold, flying with wind drift (ATTI) | GPS / ATTI / Manual |

## Locations

Change the location in **Menu → Fly → Location**.

- **Airfield:** RC club field with an asphalt runway, mown grass, race gates and a lake.
- **Forest:** hills with dense pines and broadleaf trees, a grass strip in a clearing, dirt trails, a river ravine, boulders, fallen logs and a wooden hunting tower.
- **City:** about 1.4 km of street grid:
  - glass and office towers downtown, brick and concrete blocks, low-rise outskirts
  - roads with crosswalks, moving traffic, parked cars, streetlights and street trees
  - parks, plus two abandoned concrete frames ("bandos") to fly through
  - a baked sun shadow map, so skyscrapers shade the streets
  - stronger turbulence between buildings

## FPV camera

- **Lens:** a wide-angle lens with fisheye distortion, chromatic aberration and vignette, with your own props blurring in the top corners.
- **Video:** choose **HD digital** (clean picture; macroblocking and frozen frames when the signal drops) or **Analog 5.8 GHz** (noise, scanlines, colour bleed and breakup).
- **Video signal:** quality depends on distance and on obstruction by buildings, trees and terrain between you and the aircraft. Fly behind a tower and the picture breaks up.
- **OSD:** a Betaflight-style display shows voltage, mAh, link quality, mode, speed, altitude, distance home, timer, throttle and a horizon line. The camera drone uses a stabilised gimbal view with a DJI-style display.

## Physics

- 6-DOF rigid body integrated at **400 Hz**, separately from the frame rate. Rendering interpolates between physics steps.
- **Fixed-wing:**
  - Each wing panel and tail surface computes its own lift and drag from its local airflow, including rotation, wind, turbulence, prop wash and downwash. Dihedral and sweep are modelled.
  - Servos move at a realistic speed limit.
  - The prop produces torque, P-factor, slipstream swirl on the fin and gyroscopic precession: the real left-turning tendencies.
  - Ground effect makes the plane float in the flare, and the wing buffets before it stalls.
- **Multirotor:**
  - Each motor has spool-up and spool-down lag, thrust and torque, plus inflow losses, translational lift, ground effect, vortex ring state and propwash wobble.
  - A Betaflight-style rate PID drives an airmode mixer.
  - The camera drone has GPS position hold and ATTI altitude hold.
- **LiPo battery:** open-circuit voltage curve, sag from internal resistance, capacity drain and ESC low-voltage cutoff. Flight times are realistic: about 10 min for the trainer and 5" quad, about 20 min for the camera drone. You can turn drain off in Settings.
- **Environment:** wind with a height profile, gusts and turbulence. Spring/damper landing gear has wheel friction (asphalt vs grass) and nose/tail wheel steering.
- **Collisions:** physical bounces off posts and buildings. Trees can catch the aircraft. Hard impacts, as well as tree and lake strikes, count as crashes.

Run the headless physics checks with `npm run simtest`, or `npm run simtest battery` for endurance.

## Sound and music

Everything is synthesised live with WebAudio, with no audio files:

- **Motors:** a prop blade-pass tone with harmonics, electric motor whine (RPM × pole pairs) and broadband prop noise. Each quad motor is a separate voice.
- **Spatial effects:** Doppler on fly-bys, distance attenuation, high-frequency air absorption and stereo panning.
- **Other effects:** wheel rumble, impact and crash sounds, and field ambience (gusty wind and birds).
- **Music:** a generated lo-fi soundtrack that never repeats, with electric piano, pads, bass, drums, reverb and vinyl crackle. There are volume, on/off and next-track controls in Settings.

## Graphics and performance

Three.js with a procedural world: no external assets are downloaded.

- **Terrain:** splat shading blends grass, dirt, rock and snow textures, with anti-tiling.
- **Trees and bushes:** leaf-card trees with wind sway.
- **Grass:** GPU grass that wraps around the camera.
- **Aircraft:** painted liveries with clear-coat, twisted props and a pilot figure.
- **Light and sky:** real shadows from the sun, and a sky with procedural clouds.
- **Quality presets Low / Medium / High** control grass density, tree detail, shadows, antialiasing and resolution.
- **Dynamic resolution** keeps the frame rate smooth on slow machines.

## Keyboard fallback

`W/S` throttle · arrows: aileron/elevator · `A/D` rudder · `1 2 3` mode · `E` arm · `R` reset · `C` camera · `P` pause · `H` HUD · `Esc` menu

## Project layout

```
src/sim/       physics: rigid body, fixed-wing, multirotor, battery, world (terrain, wind, obstacles), presets
src/audio/     motor/ambience sound synthesis + procedural music
src/render/    three.js scenery, aircraft models, cameras, procedural textures
src/input/     Gamepad API + keyboard
src/ui/        HUD, menu, controller setup wizard
scripts/       headless physics test
```
