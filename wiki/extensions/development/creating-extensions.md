# Creating Extensions

## Extension Structure and API

Extensions are made from 2 main files, the manifest and the extension script.

### Manifest

The manifest is a JSON file that describes the extension and its capabilities, for example:

```json
[
  {
    "name": "My Example Extension", // User friendly name displayed in Hayase
    "id": "myexample", // Unique identifier for the extension, used internally
    "version": "1.0.0", // Version number for updates
    "type": "torrent", // Type of extension (e.g., "torrent", "nzb")
    "accuracy": "medium", // Search accuracy level (e.g., "low", "medium", "high")
    "updatePeers": false, // If the user should scrape peer counts themselves from trackers, or if the extension will provide updated peer counts in search results (only for torrent extensions), optional 
    "ratio": 0, // Seeding ratio requirement (0 means no requirement) // Not implemented yet
    "media": "sub", // Type, (e.g., "sub", "dub", "both", "music"), this is purely for user information and doesn't affect search results
    "languages": ["US"], // Array of 2 letter supported languages/country flags (e.g., 'ALL' | 'US' | 'JP' | 'KR' | 'CN' | 'RU' | 'FR' | 'DE' | 'ES'), this is purely for user information and doesn't affect search results
    "url": "aHR0cHM6Ly9leGFtcGxlLmNvbQ==", // Base64 encoded URL which the extensions needs to be CORS enabled to work, optional
    "icon": "https://example.com/icon.png", // User friendly icon displayed in search results
    "update": "https://example.com/index.json", // URL to check for updates, should return a manifest with a higher version number when an update is available, usually the same URL as the manifest, optional
    "code": "https://example.com/myexample.js", // URL to the extension script, should be CORS enabled
    "options": {
      "myOptionName1": {
        "type": "boolean",
        "description": "User visible description of the option, shown in the extension settings",
        "default": false
      },
      "myOptionName2": {
        "type": "string",
        "description": "User visible description of the option, shown in the extension settings",
        "default": "My string value"
      },
      "myOptionName3": {
        "type": "number",
        "description": "User visible description of the option, shown in the extension settings",
        "default": 42
      },
    } // optional
  }
]
```

3 notable fields here are `accuracy`, `url`, and `options`.

Accuracy is used to give users an idea of the quality of the extension, and to filter rank low quality extensions lower. Make sure to set this appropriately based on accurate the extension is, for example if it just does string searches and returns a lot of irrelevant results, it should be "low", if it uses some sort of ID mapping to get mostly accurate results, it should be "medium", and if it has perfect accuracy it should be "high".

The `url` field is used to specify the base URL of the extension, this is used for CORS requests and should be set to the domain of the extension's API or website. If the extension doesn't require CORS requests, this can be left empty.

The `options` field is used to specify any user configurable options for the extension, these will be displayed in the extension settings and their configuration will be passed to the extensions as a `options` parameter.

### Extension Script

Extension scripts are JavaScript files that implement the functionality of the extension. They are ran inside a sandboxed Web Worker environment, which means they don't have access to the DOM or many browser APIs, but can perform network requests and use standard JavaScript features.

They **MUST be BUNDLED** and export an object via ESM's `export default` syntax with 4-5 methods:

* `test() => Promise<boolean>`
* `single(query: TorrentQuery, options?: Record<string, string | number | boolean>) => Promise<TorrentResult[]>`
* `batch(query: TorrentQuery, options?: Record<string, string | number | boolean>) => Promise<TorrentResult[]>`
* `movie(query: TorrentQuery, options?: Record<string, string | number | boolean>) => Promise<TorrentResult[]>`
* `query(infoHash: string, options?: Record<string, string | number | boolean>, fetch: typeof globalThis.fetch): Promise<string | undefined>`

The `test` method is used to check if the extension is working properly, it should return true if the extension is working and throw an error if it is not. Note that the error message will be shown to the user, so it should be descriptive and user friendly. This means that any network, parsing or other errors that can occur in the extension should be caught and handled properly, and a user friendly error message should be thrown instead.

The `single`, `batch` and `movie` methods are used to perform searches, they receive a `TorrentQuery` object which contains the search query and other relevant information, and they should return an array of `TorrentResult` objects which contain the search results. The difference between these methods is that they are used for different types of searches, for example `single` is used for single episode searches, `batch` is used for batch searches, and `movie` is used for movie searches. However, if the extension doesn't differentiate between these types of searches, it can just implement one of them and return results for all types of queries, or return no results for the types of queries it doesn't support.

The `query` method is used to get a direct URL to an NZB file for the given infoHash, this is only used for NZB extensions and should be left unimplemented for torrent extensions. The returned NZB file can be in a compressed format (e.g., gzipped) and Hayase will handle decompression automatically.

The `TorrentQuery` and `TorrentResult` types are defined as follows:

```ts
interface TorrentQuery {
  media: any // anilist Media object
  anilistId: number // anilist anime id
  anidbAid?: number // anidb anime id
  anidbEid?: number // anidb episode id
  tvdbId?: number // thetvdb anime id
  tvdbEId?: number // thetvdb episode id
  imdbId?: string // imdb id
  tmdbId?: string // tmdb anime id
  titles: string[] // list of titles and alternative titles
  episode: number
  episodeCount?: number // total episode count for the series
  absoluteEpisodeNumber?: number // absolute episode number, for anime with non-standard episode numbering
  resolution: '2160' | '1080' | '720' | '540' | '480' | ''
  exclusions: string[] // list of keywords to exclude from searches, this might be unsupported codecs (e.g., "x265"), sources (e.g., "web-dl"), or other keywords (e.g., "uncensored")
  type?: 'sub' | 'dub',
  fetch: typeof globalThis.fetch // fetch function to perform network requests, this function should be used instead of the global fetch to ensure CORS requests work properly
}
```

Notably `exclusions` is a list of keywords that the app wants to exclude from search results, this can be used to filter out unwanted results based on their titles. For example, if the environment doesn't support x265, it can add "x265" to the exclusions list and the extension should filter out any results that contain "x265" in their title.

```ts
interface TorrentResult {
  title: string // torrent title
  link: string // link to .torrent file, or magnet link or infoHash
  id?: number
  seeders: number
  leechers: number
  downloads: number
  accuracy: 'high' | 'medium' | 'low'
  hash: string // info hash
  size: number // size in bytes
  date: Date // date the torrent was uploaded
  type?: 'batch' | 'best' | 'alt'
}
```

Here, `seeders`, `leechers` and `downloads` are used to give the user an idea of the popularity and availability of the torrent, but can be left as 0, as Hayase tries to update the peer count information before presenting results anyways.

The `type` field is used to indicate the type of the torrent, for example if it's a batch release, a best quality release, or an 2nd best quality release. `best` and `alt` should only be set if the content is manually verified to be the best or 2nd best release for that content, otherwise they should be left empty!!!

`accuracy` is an override for the extension's overall accuracy, it can be used to mark certain results as low accuracy if they are known to be unreliable, for example if the extension is doing string searches and the result is a very common title that can easily lead to false positives, it can be marked as low accuracy.

## Handling User Errors Properly

Any of your extension's methods can throw an error if something goes wrong, for example if a network request fails, if the response is in an unexpected format, or if the extension is not configured properly. When throwing errors, make sure to provide a user friendly error message that explains what went wrong and how to fix it. This will help users understand and resolve issues with your extension more easily.

## Online/Offline Mode Support

Hayase still query extensions and show search results even when the user is offline, this is done to allow users to see previously searched content and continue watching it without an internet connection. If your extension supports offline mode, you can return results even when the user is offline, for example by caching previous search results and returning them when the user is offline, or by hardcoding values in the extension's source code. Be mindful that the user might not be able to download any content while offline, unless there's a device found on the LAN via Local Service Discovery that has the content already downloaded.

## Best Practices

* Don't perform string searches
* Prefer ID mappings when possible
* Only return Best/Alt for manually verified content
* Handle errors and timeouts
