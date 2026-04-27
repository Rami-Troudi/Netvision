import Head from 'next/head'
import dynamic from 'next/dynamic'

const NetVisionDashboard = dynamic(() => import('../src/main'), { ssr: false })

export default function Home() {
  return (
    <>
      <Head>
        <title>NetVision Digital Twin | Tunisia RAN Command Center</title>
        <meta name="description" content="Premium Tunisia regional RAN command center for NetVision Digital Twin." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <NetVisionDashboard />
    </>
  )
}
