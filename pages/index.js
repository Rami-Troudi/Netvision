import Head from 'next/head'
import dynamic from 'next/dynamic'

const NetVisionDashboard = dynamic(() => import('../src/main'), { ssr: false })

export default function Home() {
  return (
    <>
      <Head>
        <title>NetVision Supervision RAN</title>
        <meta name="description" content="Poste de supervision RAN pour les équipes NOC et radio." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <NetVisionDashboard />
    </>
  )
}
