// The About tab: the dataset, its classes, how this app counts, accuracy and caveats from the paper, and credits.
import {$, esc} from "./util.js";
import {S, on} from "./state.js";

export function renderAbout() {
  const m = S.meta, pal = m.palettes[S.palette];
  $("#about").innerHTML = `<div class="about">
  <div class="group">
    <h3>The dataset</h3>
    <p><b>Forest Typology (ForTy) 2020 v1.0</b> is Google's global 10 m map of forest <i>types</i>, made with WRI and IIASA.
      It goes beyond tree cover: every pixel gets a relative confidence score for five forest and tree-crop classes,
      and the sixth class, Other land, is what remains (250 minus their sum). The map shows conditions in 2020, the EU
      Deforestation Regulation (EUDR) cut-off year. Its main input is AlphaEarth Foundations satellite embeddings.</p>
    <p class="note">Earth Engine: <code>${esc(m.collection)}</code> ·
      <a href="${esc(m.catalog)}" target="_blank" rel="noopener">catalog page</a> ·
      <a href="https://doi.org/10.1038/s41597-026-08299-5" target="_blank" rel="noopener">paper</a> ·
      <a href="https://deepmind.google/blog/beyond-tree-cover-mapping-the-worlds-forest-types/" target="_blank" rel="noopener">Google DeepMind article</a></p>
  </div>
  <div class="group">
    <h3>Classes</h3>
    <table class="classdefs"><tbody>${m.classes.map((c, i) => `<tr><td><i class="sw" style="background:${pal[i]}"></i></td>
      <td><b>${c.id}. ${esc(c.name)}</b><br><span class="note">${esc(c.desc)}</span></td></tr>`).join("")}</tbody></table>
    <p class="note">Forest (FAO) = classes 1–4. Natural forest = 1–2. Tree crops (5) count as agricultural land under the EUDR.</p>
  </div>
  <div class="group">
    <h3>How this app counts</h3>
    <ul>
      <li><b>Winning class</b> (default): each pixel takes its highest-scoring class, the publisher's rule. It matches the
        publisher's own classification collection on every pixel tested.</li>
      <li><b>Confidence threshold</b>: keeps a pixel's class only if its winning score is at least the threshold. The rest
        is reported as <i>Uncertain</i>. The paper's advice: raise it to cut false positives (users' accuracy), lower it
        to miss less (producers' accuracy).</li>
      <li><b>Score-weighted</b>: each pixel adds its six scores, so a mixed pixel counts partly toward several classes.
        The paper suggests this "full range" view for extent estimates.</li>
      <li><b>Summed score ≥ 0.5</b>: the paper's way to build forest and natural-forest masks. It sums the class scores
        (1–4 or 1–2) instead of taking the winner.</li>
      <li>Every statistic is computed at the native 10 m resolution, on the dataset's own UTM grid (EPSG:32646 west of
        96° E, 32647 east), with true pixel areas. Admin units come from a township atlas precomputed this way. Drawn or
        uploaded areas run live in Earth Engine, cut by township so they break down too. Edge pixels count by the share
        of the pixel inside the area.</li>
      <li>Map tiles are rendered at screen zoom. When zoomed out, Earth Engine averages the scores before picking the
        winner, so small patches can vanish. The numbers are always computed at 10 m.</li>
    </ul>
  </div>
  <div class="group">
    <h3>Accuracy (from the paper)</h3>
    <ul>
      <li>Six classes: overall accuracy 90.2% against 8,190 expert-labelled random sites. Forest / non-forest: 95.5% (forest F1 92.6%). Natural forest vs the rest: 94.8%.</li>
      <li>F1 by class: Other land 96.4%, Primary 82.9%, Naturally regenerating 72.6%, Plantation 66.7%, Planted 58.2% (the hardest).</li>
      <li><b>In Asia the map assigns too much Primary and too little Naturally regenerating forest</b>: 859 vs 661 Mha
        primary and 383 vs 576 Mha regenerating, map vs sample-based. Natural forest overall agrees (1,243 vs 1,238 Mha).
        For Myanmar, trust the natural-forest total more than its split into primary and regenerating.</li>
      <li><b>Measured in Myanmar by this app:</b> the Planted forest score never exceeds 0.01 inside the country, and
        Plantation forest totals about 140 km² nationwide, so plantations here are counted under other classes.
        Nationally the map shows 63.9% forest (Primary 32.7%, Naturally regenerating 31.1%), 2.4% tree crops and
        33.7% other land.</li>
      <li>Scores are ensemble softmax outputs and are not calibrated. Check the score distribution of your own area, and
        validate locally before using a threshold for decisions.</li>
    </ul>
  </div>
  <div class="group">
    <h3>Known limitations</h3>
    <ul>
      <li>Primary forest is drawn conservatively near roads, settlements and farmland.</li>
      <li>Shaded agroforestry (coffee, tea or cocoa under native canopy) can show as natural forest.</li>
      <li>Recently harvested plantations and forest recovering after fire or clearing can appear as Other land, although
        they are still forest by intent. Areas that burned in 2020 are especially uncertain.</li>
      <li>Other wooded land (5–10% canopy), an EUDR category of its own, is inside Other land.</li>
      <li>Planted vs plantation uses a 40-year rotation as a stand-in for management intensity, which imagery cannot show.</li>
      <li>Mixed pixels at class edges and smallholder mosaics are less reliable at 10 m, and the input's effective resolution may be coarser.</li>
      <li>Water is part of Other land. The publisher's coastal tiles also give open sea an Other land score, which shows as
        square blocks offshore. MIMU units follow the coastline, so their figures are unaffected. For a drawn or uploaded
        area that reaches into the sea, the sea part is listed as “Outside Myanmar” in the breakdown.</li>
    </ul>
  </div>
  <div class="group">
    <h3>Colours</h3>
    <p>The class map uses the publisher's palette by default, so it matches the catalog and the paper. In that palette,
      Planted and Plantation forest are hard to tell apart with red-green colour blindness, and the two yellows are close
      for everyone. <b>Colour-blind safe</b> (Map tab) switches to a palette that passes those checks, with Other land in neutral grey.</p>
  </div>
  <div class="group">
    <h3>Credits and citation</h3>
    <p>${esc(m.citation)}</p>
    <p class="note">Dataset licence: CC BY 4.0. ${esc(m.mimu)} (Myanmar Information Management Unit). Basemaps and labels: Esri.
      Computation: Google Earth Engine, project <code>${esc(m.project)}</code>. Uploaded files are read in your browser;
      only the final polygon is sent to the server for analysis. App version ${esc(m.algo_version)}.</p>
  </div>
</div>`;
}
on("palette", () => { if (S.meta) renderAbout(); });
