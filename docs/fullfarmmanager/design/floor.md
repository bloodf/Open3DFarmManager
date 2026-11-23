# Machine floor design evidence

The captures use the application routes with synthetic assignments, no browser device key, pt-BR, reduced motion and 1× pixel ratio. The disconnected fixture exercises the read-only state; no printer receives commands. Desktop is 1440 × 900 and mobile is 390 × 844.

| Screen      | View    | Theme | Before                                               | After                                              |
| ----------- | ------- | ----- | ---------------------------------------------------- | -------------------------------------------------- |
| farm        | desktop | light | [Before](floor-farm-before-desktop-light.png)        | [After](floor-farm-after-desktop-light.png)        |
| farm        | desktop | dark  | [Before](floor-farm-before-desktop-dark.png)         | [After](floor-farm-after-desktop-dark.png)         |
| farm        | mobile  | light | [Before](floor-farm-before-mobile-light.png)         | [After](floor-farm-after-mobile-light.png)         |
| farm        | mobile  | dark  | [Before](floor-farm-before-mobile-dark.png)          | [After](floor-farm-after-mobile-dark.png)          |
| impressoras | desktop | light | [Before](floor-impressoras-before-desktop-light.png) | [After](floor-impressoras-after-desktop-light.png) |
| impressoras | desktop | dark  | [Before](floor-impressoras-before-desktop-dark.png)  | [After](floor-impressoras-after-desktop-dark.png)  |
| impressoras | mobile  | light | [Before](floor-impressoras-before-mobile-light.png)  | [After](floor-impressoras-after-mobile-light.png)  |
| impressoras | mobile  | dark  | [Before](floor-impressoras-before-mobile-dark.png)   | [After](floor-impressoras-after-mobile-dark.png)   |
| detail      | desktop | light | [Before](floor-detail-before-desktop-light.png)      | [After](floor-detail-after-desktop-light.png)      |
| detail      | desktop | dark  | [Before](floor-detail-before-desktop-dark.png)       | [After](floor-detail-after-desktop-dark.png)       |
| detail      | mobile  | light | [Before](floor-detail-before-mobile-light.png)       | [After](floor-detail-after-mobile-light.png)       |
| detail      | mobile  | dark  | [Before](floor-detail-before-mobile-dark.png)        | [After](floor-detail-after-mobile-dark.png)        |

The capture test checks viewport width, WCAG axe rules on screen content and the open inspector, the details link, Escape and focus return. Existing component tests also check axe, keyboard navigation, widths and degraded controls. A full-page axe best-practice scan identified duplicate banner landmarks in the shared shell; this is outside the screen content checks and remains for shell integration.
