# The house kit

Every product Cambrian builds follows these rules. They sit beside the brief; the brief decides what is
built, the house kit decides how it looks and behaves.

## Look

- Copy `tokens.css` from this folder into the product and load it first. Use its variables; do not
  write new colours, radii or type sizes beside them.
- Black ground (`--ground`), white ink (`--ink`). Cards use the two card gradients. One accent, `--live`,
  for something that is happening now, and nothing else.
- One sans face (`--font-sans`) and one mono face (`--font-mono`) for small capital labels. The fallbacks
  in the variables are fine; do not load a font from another host.
- Rounded cards (`--radius-card`), a visible focus ring (`--focus-ring`), generous spacing. No drop
  shadows, no gradients other than the card ones, no emoji as icons.

## Words

- Short declarative sentences. No exclamation marks, no hype words.
- Say what a thing is before using its name.

## Behaviour

- Works on a phone at 390 px wide and on a desktop at 1440 px, with no horizontal scroll.
- Every control is reachable by keyboard and has a label a screen reader can say.
- Respects `prefers-reduced-motion`.
- Loads nothing from another host: no fonts, scripts, images or analytics from elsewhere.
