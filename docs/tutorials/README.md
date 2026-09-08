# Tutorials

Task-oriented walkthroughs: how to do a thing, start to finish, in the web interface.
Each one starts with what you will have at the end, gives real parameter values, and says
what happens when they are wrong.

## With real data

These use the **[YmerFlow demo data](https://github.com/YmerFlow/ymerflow-demo-data)**: one
SkyTEM 304 flight line from the 2018 ENWRA survey in eastern Nebraska, the contractor's own
inversion input, and the published resistivity model to compare against. Download it with
`python3 download.py` from that repository, or from its release page.

1. **[From delivered data to a resistivity model](https://github.com/YmerFlow/ymerflow-demo-data/blob/main/tutorials/01-delivered-data-to-resistivity-model.md)**
   — import the line as SkyTEM delivered it, process it with a full chain (error model,
   culls, averaging), invert it, and compare with the published model. The processing
   section explains which parameters change the answer and why. About 20 minutes of your
   time plus a 5–15 minute inversion.
2. **[From an inversion export to a resistivity model](https://github.com/YmerFlow/ymerflow-demo-data/blob/main/tutorials/02-inversion-export-to-resistivity-model.md)**
   — import the soundings the contractor actually inverted, with their uncertainties, and
   invert them. The shortest path from download to a model you can check against the
   published one.
3. **[Sizing a job so it finishes](https://github.com/YmerFlow/ymerflow-demo-data/blob/main/tutorials/03-sizing-a-job.md)**
   — CPU, memory and deadline for a TEM inversion, from measured runs. Read this before
   submitting anything larger than a single short line.

## With synthetic data

- **[Forward modeling a synthetic survey](forward-modeling.md)** — build a resistivity
  model, simulate a survey over it, process and invert the result, and compare against the
  model you started with. The one workflow where you know the right answer in advance.
