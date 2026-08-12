# Tutorials

Task-oriented walkthroughs: how to actually do a thing, start to finish.

These are different from the rest of the docs. `architecture/` explains how the system is
built, `plans/` records what we intend to build, and `user-guide.md` describes what each
part of the interface does. Tutorials answer a different question — *I want to accomplish
X, what do I do?*

## Available

- [Forward modeling a synthetic survey](forward-modeling.md) — build a resistivity model,
  simulate a survey over it, process and invert the result, and compare against the model
  you started with.

## Writing a tutorial

**Write for a user who has the web interface and nothing else.**

Developers on this project have shell access to the host, can call the API directly, can
rebuild runner images, and can read the source. Almost nobody else can. A tutorial that
quietly depends on any of that is not a tutorial — it is a description of how we happen to
work, and it will strand the reader at the first step they cannot perform.

If a step genuinely cannot be done through the interface, that is a product gap. Say so
plainly in the tutorial and open an issue, rather than routing the reader around it.

Beyond that:

- **Start with what the reader will have at the end**, so they can judge whether to invest
  the time.
- **Give real numbers.** "Set a reasonable window" helps nobody. Say what to use, and say
  what happens if it is wrong.
- **Explain the choices that matter and skip the ones that don't.** A parameter that
  changes the answer deserves a paragraph; one that never moves deserves a default.
- **Include the failure modes.** The ones that fail loudly are easy. Document the ones that
  fail *silently* — where the job succeeds and the answer is quietly wrong — because those
  are what cost people days.
- **Mark uncertainty.** If you are unsure of a button label, write `[verify]` rather than
  guessing. A confident wrong instruction is worse than a flagged gap.
