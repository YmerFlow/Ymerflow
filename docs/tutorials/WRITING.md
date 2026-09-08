# Writing a tutorial

Guidelines for the people writing tutorials. This file is not published on the docs site
(see `UNPUBLISHED` in `pages/build.py`); `README.md` in this directory is.

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
- **Nothing unfinished goes on the site.** No draft banners, no `[verify]` markers, no
  notes to other authors. If a step is unverified, verify it before publishing or open an
  issue and leave the step out. A reader cannot tell a flagged gap from an instruction.
