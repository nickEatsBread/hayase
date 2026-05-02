<script lang='ts'>
  import { toast } from 'svelte-sonner'

  import SettingCard from '$lib/components/SettingCard.svelte'
  import { Button } from '$lib/components/ui/button'
  import { SingleCombo } from '$lib/components/ui/combobox'
  import { Input } from '$lib/components/ui/input'
  import { Switch } from '$lib/components/ui/switch'
  import native from '$lib/modules/native'
  import { settings, SUPPORTS } from '$lib/modules/settings'

  import type { DebridProviderId } from 'native'

  async function selectDownloadFolder (type?: string) {
    try {
      $settings.torrentPath = await native.selectDownload(type as 'cache' | 'internal' | 'sdcard' | undefined)
    } catch (error) {
      toast.error('Failed to select download folder. Please try again.', {
        description: error instanceof Error ? error.message : 'Unknown error occurred.'
      })
    }
  }

  const androidDirectories = {
    cache: 'Cache',
    internal: 'Internal Storage',
    sdcard: 'SD Card'
  } as const

  const debridProviders: Record<DebridProviderId, string> = {
    none: 'Disabled (use BitTorrent)',
    realdebrid: 'Real-Debrid',
    alldebrid: 'AllDebrid',
    premiumize: 'Premiumize',
    torbox: 'TorBox'
  }

  const debridApiPages: Partial<Record<DebridProviderId, string>> = {
    realdebrid: 'https://real-debrid.com/apitoken',
    alldebrid: 'https://alldebrid.com/apikeys/',
    premiumize: 'https://www.premiumize.me/account',
    torbox: 'https://torbox.app/settings'
  }

  let testing = false
  async function testDebrid () {
    testing = true
    try {
      const status = await native.checkDebrid($settings.debridProvider, $settings.debridApiKey)
      toast.success(`${debridProviders[status.provider]} authenticated`, {
        description: `${status.user}${status.premium ? ' (premium)' : ' - free account, may have limited functionality'}${status.expiration ? ` until ${new Date(status.expiration).toLocaleDateString()}` : ''}`
      })
    } catch (error) {
      toast.error('Debrid authentication failed', {
        description: error instanceof Error ? error.message : 'Unknown error occurred.'
      })
    } finally {
      testing = false
    }
  }
</script>

<div class='font-weight-bold text-xl font-bold'>Security Settings</div>
{#if !SUPPORTS.isIOS}
  {#if !SUPPORTS.isAndroid}
    <SettingCard let:id title='Use DNS Over HTTPS' description='Enables DNS Over HTTPS, useful if your ISP blocks certain domains.'>
      <Switch {id} bind:checked={$settings.enableDoH} />
    </SettingCard>
    <SettingCard let:id title='DNS Over HTTPS URL' description='What URL to use for querying DNS Over HTTPS.'>
      <Input type='url' bind:value={$settings.doHURL} {id} class='w-80 shrink-0 bg-background' />
    </SettingCard>
  {:else}
    <SettingCard title='Use DNS Over HTTPS' description="Enables DNS Over HTTPS, useful if your ISP blocks certain domains. On Android this is a system setting, which cannot be changed here. It's usually named 'Private DNS' or 'DNS over HTTPs'.">
      <Button class='font-bold' on:click={() => native.setDOH('')} variant='secondary'>Configure DoH</Button>
    </SettingCard>
  {/if}
{/if}

<div class='font-weight-bold text-xl font-bold'>Client Settings</div>
{#if !SUPPORTS.isIOS}
  <SettingCard let:id title='Torrent Download Location' description={`Path to the folder used to store torrents. By default this is the OS's TEMP/TMP cache folder, which might lose data when your OS tries to reclaim storage.${SUPPORTS.isAndroid ? '\n\nSD Card saves to the Cards Download folder. If SD Card is not available torrents will automatically be saved to the Phone\'s Downloads folder' : ''}`}>
    <div class='flex'>
      <Input type='url' bind:value={$settings.torrentPath} readonly {id} placeholder='/tmp/webtorrent' class='sm:w-60 bg-background rounded-r-none pointer-events-none' />
      {#if !SUPPORTS.isAndroid}
        <Button class='rounded-l-none font-bold' on:click={() => selectDownloadFolder()} variant='secondary'>Select Folder</Button>
      {:else}
        <SingleCombo bind:value={$settings.androidStorageType} items={androidDirectories} class='w-32 shrink-0 border-input border rounded-l-none ' onSelected={selectDownloadFolder} />
      {/if}
    </div>
  </SettingCard>
{/if}
<SettingCard let:id title='Persist Files' description="Keeps torrents files instead of deleting them after a new torrent is played. This doesn't seed the files, only keeps them on your drive. This will quickly fill up your storage.">
  <Switch {id} bind:checked={$settings.torrentPersist} />
</SettingCard>
<SettingCard let:id title='Streamed Download' description="Only downloads the data that's directly needed for playback, down to the minute, instead of downloading an entire batch of episodes. Will not buffer ahead more than a few seconds, and will stop downloading once the few second buffer is filled. Saves bandwidth and reduces strain on the peer swarm.">
  <Switch {id} bind:checked={$settings.torrentStreamedDownload} />
</SettingCard>
<SettingCard let:id title='Transfer Speed Limit' description='Download/Upload speed limit for torrents, higher values increase CPU usage, and values higher than your storage write speeds will quickly fill up RAM.'>
  <div class='flex items-center relative scale-parent border border-input rounded-md self-baseline'>
    <Input type='number' inputmode='numeric' pattern='[0-9]*.?[0-9]*' min='1' max='50' step='0.1' bind:value={$settings.torrentSpeed} {id} class='w-32 shrink-0 bg-background pr-12 border-0 no-scale' />
    <div class='shrink-0 absolute right-3 z-10 pointer-events-none text-sm leading-5'>Mb/s</div>
  </div>
</SettingCard>
<SettingCard let:id title='Max Number of Connections' description='Number of peers per torrent. Higher values will increase download speeds but might quickly fill up available ports if your ISP limits the maximum allowed number of open connections.'>
  <Input type='number' inputmode='numeric' pattern='[0-9]*' min='1' max='512' bind:value={$settings.maxConns} {id} class='w-32 shrink-0 bg-background' />
</SettingCard>
<SettingCard let:id title='Forwarded Torrent Port' description='Forwarded port used for incoming torrent connections. 0 automatically finds an open unused port. Change this to a specific port if you forwarded manually, or if you use a VPN'>
  <Input type='number' inputmode='numeric' pattern='[0-9]*' min='0' max='65536' bind:value={$settings.torrentPort} {id} class='w-32 shrink-0 bg-background' />
</SettingCard>
<SettingCard let:id title='DHT Port' description='Port used for DHT connections. 0 is automatic.'>
  <Input type='number' inputmode='numeric' pattern='[0-9]*' min='0' max='65536' bind:value={$settings.dhtPort} {id} class='w-32 shrink-0 bg-background' />
</SettingCard>
<SettingCard let:id title='Disable DHT' description='Disables Distributed Hash Tables for use in private trackers to improve privacy. Might greatly reduce the amount of discovered peers.'>
  <Switch {id} bind:checked={$settings.torrentDHT} />
</SettingCard>
<SettingCard let:id title='Disable PeX' description='Disables Peer Exchange for use in private trackers to improve privacy. Might greatly reduce the amount of discovered peers.'>
  <Switch {id} bind:checked={$settings.torrentPeX} />
</SettingCard>

<div class='font-weight-bold text-xl font-bold'>Debrid Service</div>
<SettingCard let:id title='Debrid Provider' description='Stream torrents through a debrid service instead of peer-to-peer. Debrid services download the torrent on their servers and give you a high-speed HTTP link, which avoids the need to torrent locally and bypasses ISP throttling. Requires a paid account with the chosen provider.'>
  <SingleCombo {id} bind:value={$settings.debridProvider} items={debridProviders} class='w-64 shrink-0 border-input border' />
</SettingCard>
{#if $settings.debridProvider !== 'none'}
  <SettingCard let:id title='Debrid API Key' description='Your API token from {debridProviders[$settings.debridProvider]}. Stored locally only.'>
    <div class='flex w-full sm:w-auto'>
      <Input
        {id}
        type='password'
        autocomplete='off'
        bind:value={$settings.debridApiKey}
        placeholder='paste your API key here'
        class='sm:w-80 bg-background rounded-r-none' />
      <Button class='rounded-l-none font-bold' on:click={testDebrid} disabled={testing || !$settings.debridApiKey} variant='secondary'>
        {testing ? 'Testing…' : 'Test Key'}
      </Button>
    </div>
  </SettingCard>
  {#if debridApiPages[$settings.debridProvider]}
    <SettingCard title='Get an API Key' description={`Open ${debridProviders[$settings.debridProvider]}'s API key page to generate or copy your token.`}>
      <Button class='font-bold' on:click={() => native.openURL(debridApiPages[$settings.debridProvider]!)} variant='secondary'>Open Provider</Button>
    </SettingCard>
  {/if}
{/if}
