import Head from 'next/head'

export default function SitePlanning() {
  return (
    <>
      <Head>
        <title>Site Planning</title>
      </Head>
      <main style={{ maxWidth: '900px', margin: '40px auto', padding: '24px', fontFamily: 'Inter, sans-serif' }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <span className="material-symbols-outlined">add_location_alt</span>
          Site Planning
        </h1>
        <p style={{ color: '#444', lineHeight: 1.6, marginBottom: '16px' }}>
          Inline cell actions don&apos;t create new sites. Use this dedicated flow to model a new site (location, band mix, tilt, power) and evaluate coverage/capacity uplift.
        </p>
        <ul style={{ paddingLeft: '20px', color: '#444', lineHeight: 1.6 }}>
          <li>Step 1: Define coordinates and planned bands.</li>
          <li>Step 2: Configure antenna params (tilt, azimuth, power).</li>
          <li>Step 3: Run coverage/capacity simulation (fast estimator).</li>
        </ul>
        <p style={{ marginTop: '16px', color: '#666' }}>
          This is a placeholder. Provide the site data to proceed, or ask to wire this into the simulator API.
        </p>
      </main>
    </>
  )
}
