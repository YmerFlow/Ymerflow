# Tutorial: Forward modeling a synthetic survey

> **Draft.** The workflow, parameters and guidance below are accurate. Exact button labels
> and screenshots still need a pass from someone with the interface open — search for
> `[verify]` markers.

**What you will do:** build a resistivity model by hand, simulate what an airborne EM
system would measure over it, add realistic noise, process and invert that simulated data,
and compare the result against the model you started with.

**Why this is worth doing:** it is the only workflow where you know the right answer in
advance. Everything else in geophysics is inference. Here you can ask whether a given
system, flown a given way, would actually see the thing you care about — before anyone
spends money flying it.

**Time:** about an hour, most of it waiting for jobs to finish.

**You need:** a project you can create processes in, and an environment that provides the
`forward_tem`, `process_tem` and `invert_tem` process types. Everything happens in the web
interface.

---

## The example

We will build a two-layer earth with a narrow vertical fault cutting through it, and ask
whether a dual-moment time-domain system would resolve the fault.

| | |
|---|---|
| Line length | 2 km |
| Sounding spacing | 30 m |
| Overburden | 300 Ω·m, 0–10 m |
| Basement | 1000 Ω·m, below 10 m |
| Fault | 33 m wide, 300 Ω·m, from 10 m down |

The fault is more conductive than the basement it cuts, and narrow relative to anything the
system was designed to resolve. That makes it a genuinely hard target, which is the point —
an easy target tells you nothing.

---

## Step 1 — Build the model

Open the **Model Simulator** and create a new model. `[verify: exact name and location]`

Set the line geometry first — length and sounding spacing — then draw the layers:

1. Set the background to 1000 Ω·m. This is your basement.
2. Add a 10 m surface layer at 300 Ω·m across the whole line.
3. Draw the fault: a vertical column 33 m wide at 300 Ω·m, starting at 10 m depth and
   continuing to the bottom of the model.

**Check the model before going further.** Plot it and look at it. A model with a
mis-drawn layer will forward-model and invert perfectly happily, and you will not find out
until the results make no sense. This is the cheapest checkpoint in the whole workflow.

> **Known limitation:** the Model Simulator cannot currently re-open models it has saved
> (issue #27). Build your model in one sitting, and if you need variants, make them all
> before moving on.

### Choosing your sounding spacing

Sounding spacing is the first real decision and it is easy to get wrong.

**If you only want to know whether the target is detectable,** model at the spacing the
data will actually be delivered at — 30 m is typical. This is roughly ten times cheaper to
run than modeling at the raw acquisition interval.

**If you want to study how processing affects the result,** model at the raw acquisition
interval instead — around 3 m. You then have real soundings to average together, and you
can vary that averaging. This costs about ten times as much compute.

One catch if you choose the coarse route: a real 30 m sounding is built by stacking roughly
ten raw soundings together, and that stacking reduces noise by about a factor of three. If
you model directly at 30 m and apply full per-sounding noise, you are simulating a survey
noisier than the one you would actually fly. Lower the noise floor accordingly — see
[how noise scales](#a-little-theory-how-noise-scales-and-what-that-means-at-your-output-spacing)
in Step 3 — or the test will be unfairly pessimistic.

---

## Step 2 — Forward model

Create a new process of type **`forward_tem`**.

- **Input model:** the model from Step 1
- **System:** the instrument you are testing. Its gate times, transmitter moments and
  geometry come from the system's calibration file, so this single choice carries a lot.
- **Gate filter:** leave it wide open for the forward run. You want every gate the system
  produces; you can discard gates later, but you cannot recover ones you never simulated.

Resources: forward modeling a 2 km line at 30 m spacing is quick. At 3 m spacing it is
substantially heavier — give it more cores and a generous deadline. **Unused deadline does
not cost anything; a job killed at its deadline produces nothing at all.**

Watch it run in **ProcessLog**. When it finishes you have a clean, noise-free simulation:
what the system would measure over your model in a world without interference. That is not
a realistic dataset yet, which is what Step 3 is for.

**Look at the clean response before continuing.** Plot dB/dt along the line for a few
gates. You should see the fault as a bump. If it is not visible in clean data, no amount of
processing will find it in noisy data, and you have your answer already.

---

## Step 3 — Add noise and process

Create a process of type **`process_tem`**, with the forward output as its input.

The order of the steps matters, and it is not arbitrary:

**1. Assign the error model** — *STD error: Replace from GEX*, once per channel.

Set `noise_level_1ms`, the absolute noise floor at 1 ms. This is the single most consequential
number in the tutorial. Choose it by plotting your clean response against candidate floors
and picking the one where the signal disappears into the noise at a believable gate — a
normal survey loses roughly the last quarter of its gates.

**2. Add the noise** — *Add noise realization*, once per channel.

Set a **seed**. With a fixed seed, two runs differ only by the parameters you changed. With
no seed, every run draws different noise and you cannot tell a real effect from a different
random draw.

**3. Average and decimate** — *Moving average filter*.

This step is where synthetic studies most often go wrong. See the guidance below before
choosing a window.

**4. Cull uninformative data** — *Disable gates by STD values*, threshold around `0.20`.

This drops gates whose uncertainty has grown so large they contribute nothing. It typically
removes a third to a half of the data and leaves the answer unchanged, because the inversion
was already weighting those gates near zero. It must come **after** averaging — averaging
determines which gates are worth keeping.

### A little theory: how noise scales, and what that means at your output spacing

Two different things are called "noise" here and they behave differently.

**The absolute noise floor** is ambient electromagnetic noise, and it does not care what
your signal is doing. It decays slowly with time — roughly as `t^-0.5` — which is why
`noise_level_1ms` is quoted at a reference time of 1 ms and scaled from there.

**The signal** decays far faster, closer to `t^-2.5` for a simple half-space. That
difference is the whole story of a TEM sounding: signal starts orders of magnitude above
the floor, falls much more steeply, and at some gate the two meet. Everything after that
gate is noise wearing the shape of data.

**Random noise averages down; systematic error does not.** Stacking `N` soundings reduces
the random part by `√N`. A relative error term — the few percent of calibration and
geometry uncertainty carried in the system file — does not shrink at all, because it is not
random between neighbouring soundings. The two combine in quadrature, so at some point
stacking stops helping and you are left sitting on the relative floor.

**Specifying it.** All of this is set on the same step — *STD error: Replace from GEX* —
through two optional parameters. What you supply decides which noise model you get:

| You supply | What you get |
|---|---|
| Nothing | A flat percentage taken from the system file's own uniform value, typically a few percent |
| `relative_noise_fraction` | Your own flat percentage instead, e.g. `0.03` for 3% |
| `noise_level_1ms` | A time-decaying absolute floor, falling as `t^-0.5` (adjustable via `noise_exponent`) |
| Both | The two combined in quadrature |

Uncertainties are always stored as fractions of the signal, whichever route you take.

The distinction matters more than it looks. **A percentage scales with the signal, so the
data never dies.** At very late times the signal may be a thousand times below anything
measurable, but a 3% error model still calls it 3% good — and the inversion will dutifully
fit it. A percentage-only model quietly grants you far more usable depth than you have.

An absolute floor behaves the way real ambient noise does: fixed amplitude regardless of
signal, so the decaying signal eventually falls into it and the late gates genuinely become
worthless.

Use a percentage for calibration and geometry uncertainty, which really is proportional to
signal. Use an absolute floor for ambient noise. For a realistic survey supply both — the
percentage dominates early where signal is strong, the absolute floor takes over late and
kills the gates that deserve to die.

> Supplying both together does not currently behave as a simple scaling of the error model
> — see issue #38. If your results look strange after changing the relative fraction, that
> is worth reading first.

There is also a separate *STD error: Add fractional error* step, which adds a fixed
percentage to a chosen range of gates. That is for patching a known problem in part of a
decay, not for building the error model in the first place.

**Representing that at your output spacing.** This is the part people get wrong when
modeling directly at the delivered spacing.

A delivered 30 m sounding is not one measurement. It is roughly ten raw soundings, acquired
about 3 m apart, stacked together — so it carries about `√10 ≈ 3.2` times *less* random
noise than any single raw sounding.

If you model at 3 m and average in processing, you get this for free; the pipeline does the
stacking and the error estimate follows. If you model directly at 30 m, one modeled
sounding stands in for ten real ones, and applying a full per-sounding noise floor
simulates a survey roughly three times noisier than the one you would actually fly.

So when modeling at the delivered spacing, **divide your noise floor by about `√N`**, where
`N` is the number of raw soundings that would have gone into each output sounding
(delivered spacing ÷ acquisition spacing). For 30 m output from 3 m acquisition, that is a
factor of about 3.

### Choosing the averaging window

The window is set in **number of soundings**, but what matters physically is
**window × sounding spacing** — the distance on the ground being smeared together.

Standard defaults are tuned for layered geology and are wide: 30–50 soundings on the low
moment, 50–90 on the high. At 3 m spacing that is 90–150 m and 150–270 m of lateral
averaging.

**Against a 33 m target, those defaults remove the anomaly completely.** Not degrade it —
remove it. The inversion then converges cleanly and returns a section with no fault in it,
and nothing anywhere tells you something was lost.

The rule: **keep the averaging window at the scale of your target, not the scale of your
sounding spacing.** For a narrow vertical feature that means a very small window — three
soundings is a reasonable floor.

If you are unsure, run it both ways. It costs one extra processing job and one extra
inversion, and it converts an assumption into a result.

> A window of 1 does not work — the averaging needs at least two samples to estimate an
> uncertainty, and a width-1 window silently produces empty data. Three is the minimum.

---

## Step 4 — Invert

Create a process of type **`invert_tem`** with the processed data as input.

**Start model.** Begin from a uniform half-space near the middle of your expected
resistivity range. Layer thicknesses should be fine near the surface and grow with depth —
a 5 m first layer growing geometrically to a few hundred metres is a sound default.

Note that the start model sets your resolution floor near the surface: a 5 m first layer
cannot resolve a 3 m feature, and a 10 m overburden will be blurred into whatever lies
beneath it.

**Gate filter.** Discard the earliest gates, which are contaminated by the transmitter
turn-off, and the latest, which are noise. If you injected noise using a floor in Step 3,
the gates below that floor are the ones to drop.

> Gate filter indices are counted from zero, while gate numbers elsewhere are counted from
> one. `start_lm: 6` keeps everything from the **seventh** gate onward.

**Regularization.** The defaults are a reasonable starting point. Resist the temptation to
loosen the lateral smoothing weight in the hope of sharper edges — in testing it reliably
made things worse, because a loosely-regularized inversion spends its freedom fitting noise
rather than structure.

**Resources.** Inversions want real CPU and memory. Set them explicitly; the defaults are
sized for imports.

---

## Step 5 — Compare against the truth

Open the recovered section in **PlotView** and put it next to your original model.

Use a **logarithmic** color scale for resistivity, with the same limits on both panels.
Anchor the limits to the values actually in your model — if your model contains 150, 300
and 1000 Ω·m, a scale from 150 to 1500 lets a reader decode colors against known geology.
A scale that clips your model values makes two different units look identical.

Ask three questions, in this order:

**Is it in the right place?** Position is recovered long before amplitude. A feature at the
correct location with the wrong resistivity is a success; a feature 200 m off is not.

**Is it at the right depth?** Especially the depth to the *top*. This is what distinguishes
a structure reaching the surface from one that is buried.

**Is the amplitude right?** This is the last thing to survive and the first thing to
degrade with depth. Expect recovered values to drift toward the background as sensitivity
fades — typically somewhere between 150 and 250 m for a system like this.

### Use a control

The most useful comparison is inside your own model. If part of the line has no target,
that section is your control: it shows what "nothing" looks like given the same noise and
the same processing. A feature is real when it stands out against *that*, not against your
expectations.

### Check the misfit

Look at the final NRMS.

- **Near 1.0** — the inversion fit the data to the noise level you assigned. This is what
  you want.
- **Well below 1.0** — it fit *better* than your uncertainties said it should, meaning the
  error model is too loose. The inversion had slack and never needed structure to satisfy
  the data. **A low NRMS is a warning, not a good grade.**
- **Well above 1.0** — it could not fit the data. Something is wrong: the wrong system, a
  bad start model, or an error model that is too tight.

---

## Troubleshooting

**The inversion complains about units.** Usually the data reaching it is empty rather than
mis-scaled. Check the output of your processing step actually contains numbers — an
averaging window of 1 is the classic cause.

**The recovered section is featureless.** Before concluding the target is undetectable,
check the averaging window. This is by far the most common cause, and it fails silently.

**The recovered section is noisy and spiky.** The error model is likely too loose, or the
regularization too weak. Check NRMS — if it is well below 1, that confirms it.

**A job fails immediately with a missing parameter.** Environments differ in which
parameters they require. Look at the parameter form for the process type in your
environment rather than copying settings from elsewhere.

---

## What to try next

- **Vary the target.** Make the fault narrower, deeper, or less conductive until it stops
  being resolvable. That boundary is the actual answer to "can this survey see it?"
- **Vary the noise floor.** A quiet site and a noisy one give different answers, and the
  difference is worth knowing before committing to a survey.
- **Compare systems.** Run the same model through two instruments. This is the most direct
  way to justify — or reject — paying for the more capable one.
- **Vary the processing.** Same forward data, different averaging. It is cheap, because the
  forward model only has to run once.

That last point is the habit worth forming: **run the forward model once and reuse it.**
The forward is the expensive step, and every downstream variant can share it. Re-running it
to change a processing parameter can waste hours.
