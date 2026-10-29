// 10/12 (Nic): the Metrics page heat map draws the Census county shapes that
// ship in the us-atlas package (bundled, never fetched from a CDN). Typed here
// as a TopoJSON topology so the compiler does not infer a type for an 800 KB
// file on every build.
// 10/13 (Nic): the longitude/latitude edition (the flat map projects it the way
// us-atlas's own Albers file was drawn, and the globe turns it).
declare module 'us-atlas/counties-10m.json' {
  const topology: import('topojson-specification').Topology
  export default topology
}
