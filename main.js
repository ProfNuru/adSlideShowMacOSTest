const electron = require('electron');
const { app, BrowserWindow } = electron;
const ipc = electron.ipcMain;
const os = require("os");
const download = require('image-downloader'); // Used for both images and videos
const md5File = require('md5-file');
const { readdir, stat } = require('fs/promises');
const fs = require('fs');
const url = require('url');
const fse = require('fs-extra')
const log = require('electron-log');
const schedule = require('node-schedule');
const path = require('path');
const isDev = require('electron-is-dev');
const EventEmitter = require('events');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const isReachable = require('is-reachable');
const scrape = (...args) => import('website-scraper').then(({default:scrape})=>scrape(...args));

// URLs to match and intercept
const urlFilter = {
    urls: [
        '*://sa.ds-app.com/*.png',
        '*://sa.ds-app.com/*.jpg',
        '*://sa.ds-app.com/*.mp4'
    ]
};

// Server appBaseUrl
global.appBaseUrl = "https://sa.ds-app.com";
// Main data directory
// global.appDataDir = "/home/demo/electron/resources/app/ds_data";
global.appDataDir = getAppDataPath(path.join(__dirname,'ds_data'));
// Media directory, inside appDataDir
global.appMediaDir = getAppDataPath(path.join(global.appDataDir, "media"));
// Playlist Status appModifiedOn timestamp value
global.appModifiedOn = 0;
// SlideShowJson
global.appSlideShowJson = null;

// File to write logs
global.appLogFile = path.join(__dirname,'activity.log');
log.transports.file.resolvePath = () => global.appLogFile;

// Global variables
let win;
let playlist_update_checker;
let cache_dir = path.join(__dirname,'cached_slideshow.site')
let temporal_cache = path.join(__dirname,'temporal_cache')
let slide_cache = path.join(cache_dir,'index.html')

// Load status object
const load_status = {
    status:null
}

// Event emitter object for triggering and handling event in main process
const globalEvents = new EventEmitter();

// Overriding error, warn etc.
Object.assign(console, log.functions);

// Get file path or create it if it does not exist
function getAppDataPath(path){
    try {
        if (fs.existsSync(path)) {
            return path
        } else {
            fs.mkdirSync(path)
            return path
        }
    } catch(e) {
        console.log("An error occurred.")
    }
}

// Called from whenReady function below
const createWindow = () => {
    // const {width, height} = electron.screen.getPrimaryDisplay().workAreaSize
    const {width, height} = {width: 1920, height: 1080};
    win = new BrowserWindow({
        ...(isDev ? {
            width, height
        } : {
            alwaysOnTop: true,
            fullscreen: true,
            kiosk: true,
        }),
        icon: path.join(__dirname, 'assets/icons/png/64x64.png'),
        title: "Display Science",
        roundedCorners: false,
        spellcheck: false,
        webPreferences: {
            webSecurity: false,
            backgroundThrottling: false,
            nodeIntegration:false,
            contextIsolation:true,
            preload: path.join(__dirname, "preload.js"),
        }
    })
    // Loading page.
    runSlidesFromCache(slide_cache)

    const job = schedule.scheduleJob('1 * * * *', function (){
        console.log("Relaunching app at 1 min past the hour.");

        // Emit a global reload signal.
        // This will trigger reload of the main function
        globalEvents.emit('reload')
    });

    // main()
}

// Main unused
// function main(){
//     let ses = win.webContents.session;
   
//     ses.webRequest.onBeforeRequest(urlFilter, (details, callback) => {
//         let filename = path.basename(details.url);
//         let fullLocalPath = path.join(global.appMediaDir, filename);
//         let re;
//         let pth;
//         try{
//             re = fs.readFileSync(fullLocalPath);
//             pth = url.pathToFileURL(fullLocalPath)
//         } catch(err){
//             console.log("onBeforeRequest Error:",err);
//         }
        
//         callback({
//             redirectURL: pth
//         });
//     });    
// }

async function loadUpdatedMedia(){
    // get modified on value of the playlist
    global.appModifiedOn = await getPlaylistStatusInt();
    global.appSlideShowJson = await getSlideShowJson();
    
    // Download media files if they don't exist.
    try {
        await downloadMedia();
    } catch (error) {
        console.log('Failed to fetch slide show JSON', error)
    }

    // Save to cache
    saveSlideShowToCache(global.appBaseUrl+"/panels/slideShowFullScreen/"+getDeviceName());
}

// Entry point. Runs when Electron is ready.
app.whenReady().then( () => {
    createWindow() // This calls the function defined above.
})

ipc.on('load_status',(event)=>{
    event.sender.send('load_detail', load_status.status ? load_status.status : 'Loading')
})

// This handles internet status event through the preload.js script
// Through IPC (Inter-process Communication), preload.js can send internet status from the frontend
// This allows the app to detect internet status at anytime
ipc.on('online_status',async (event,value)=>{
    if(value==='online'){
        console.log('online')
        playlist_update_checker = setInterval(function (){
            try {
                (async () => {
                    let reachable = await isReachable(global.appBaseUrl)
                    if(reachable){
                        let modifiedOn = await getPlaylistStatusInt();
                        if (global.appModifiedOn != modifiedOn){
                            console.log('Update triggered. Downloading media')
                            loadUpdatedMedia()
                        }else{
                            console.log('update not triggered', global.appModifiedOn, modifiedOn)
                            if(win.webContents.getURL() !== url.pathToFileURL(slide_cache).href){
                                // Status: offline
                                // Not loading slide show from cache
                                runSlidesFromCache(slide_cache)
                            }
                            await keepMediaDirUnder10GB()
                        }
                    }                
                })();
            } catch (error) {
                console.log('Error checking playlist status:',error)
            }
            
        }, 10000);
    }else{
        console.log('offline')
        clearInterval(playlist_update_checker)
        console.log('stopped checking for playlist status')
        if(win.webContents.getURL() !== url.pathToFileURL(slide_cache).href){
            // Status: offline
            // Not loading slide show from cache
            runSlidesFromCache(slide_cache)
        }else{
            console.log('Offline and slides loaded from cache')
        }
    }
})

// If newly downloaded files saved to cache
globalEvents.on('cache_saved',()=>{
    // Check to see if slides are not already loaded
    win.loadFile(path.join(__dirname, 'loading.html'));
    load_status.status = "Loading slides..."
    runSlidesFromCache(slide_cache)
})

globalEvents.on('media_deleted',()=>{
    load_status.status = "Media files not found. Refetching..."
    win.loadFile(path.join(__dirname, 'loading.html'));
    globalEvents.emit('reload')
})

globalEvents.on('reset_media_dir', ()=>{
    // Reset directories
    global.appDataDir = getAppDataPath(path.join(__dirname,'ds_data'));
    // Media directory, inside appDataDir
    global.appMediaDir = getAppDataPath(path.join(global.appDataDir, "media"));
    globalEvents.emit('media_deleted')
})

// Reload event triggered 1 min past every hour
globalEvents.on('reload',()=>{
    load_status.status = "Reloading..."
    loadUpdatedMedia()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})

// On MacOS, it is common to recreate the main browser window on icon click when all windows ae closed
// This event handles that
app.on('activate', function(){
    if(BrowserWindow.getAllWindows().length === 0) createWindow()
})

/**
 * **Linux**: Check if __~/device_name.txt__ exists.
 *  If yes, use its content as device name.
 *  If not use __hostname__ as device name.
 * **Mac**: Check if __ds_data/device_name.txt__ exists
 *  If yes, use its content as device name.
 *  If not, use __sa0000__ as device name.
 */

function getDeviceName(){
    const src = path.join(__dirname,'device_name.txt')
    if(fs.existsSync(src)){
        // read file
        const deviceName = fs.readFileSync(src, {encoding:'utf8', flag:'r'});
        return deviceName
    }
    return process.platform !== 'darwin' ? os.hostname() : '__sa0000__'
}

/**
 * Get slideShowJson from server using deviceName
 * @returns  JSON
 */
async function getSlideShowJson () {
    let url = global.appBaseUrl+"/panels/slideShowJson/"+getDeviceName()
    
    try {
        const result = await fetch(url)
        const res_json = await result.json()
        return res_json
    } catch (error) {
        console.log("Failed to fetch slide show. Maybe due to failed internet connection")
    }
}

/**
 * Get current appModifiedOn timestamp and return it.
 * If failed to get, handle error but don't stop the app.
 */
async function getPlaylistStatusInt () {
    let url = global.appBaseUrl+"/panels/getPlaylistStatus/"+getDeviceName()
    
    try {
        const result = await fetch(url)
        const res_json = await result.json()
        return res_json.modifiedOn
    } catch (error) {
        console.log("Failed to fetch playlist status. Maybe due to failed internet connection")
    }
}

/**
 * Parse global.slideShowJson and download all media files to ds_data/media.
 */
async function downloadMedia () {
    load_status.status = 'Loading media...'
    let ads = global.appSlideShowJson.group.playlist.advertisements;
    const imagesBaseUrl = global.appBaseUrl+"/webroot/files/Advertisements/images";
    for (let i in ads) {
        firstImage = ads[i]['first_image'];
        secondImage = ads[i]['second_image'];

        firstImageMd5 = ads[i]['first_image_md5'];
        secondImageMd5 = ads[i]['second_image_md5'];

        dlFirstImage = false; // Switch to true if md5 doesn't match
        dlSecondImage = false; // Switch to true if md5 doesnt' match
        
        // Download first image and second image
        let optionsFirstImage = {
            url: imagesBaseUrl+"/"+firstImage,
            dest: global.appMediaDir
        };
        let optionsSecondImage = {
            url: imagesBaseUrl+"/"+secondImage,
            dest: global.appMediaDir
        };
        await md5File(global.appMediaDir + "/" + firstImage)
            .then( (md5) => {
                if (md5 !== firstImageMd5){
                    load_status.status = 'First image MD5 mismatch. Downloading file...'
                    console.log("MD5 mismatch. Downloading file.");
                    console.log("MD5 on disk: " + md5 + " MD5 from server: " + firstImageMd5 + " URL: " + firstImage);
                    dlFirstImage = true;
                }
            })
            .catch( (err) => {
                load_status.status = 'First image not on disk. Downloading file...'
                console.log("File not on disk. Downloading file. " + err);
                dlFirstImage = true;
            });
        
        await md5File(global.appMediaDir + "/" + secondImage)
            .then( (md5) => {
                if (md5 !== secondImageMd5){
                    load_status.status = 'Second image MD5 mismatch. Downloading file...'
                    console.log("MD5 on disk: " + md5 + " MD5 from server: " + secondImageMd5 + " URL: " + secondImage);
                    dlSecondImage = true;
                }
            })
            .catch( (err) => {
                load_status.status = 'Second image not on disk. Downloading file...'
                console.log("File not on disk. Downloading file. " + err);
                dlSecondImage = true;
            });

        if (dlFirstImage){
            await download.image(optionsFirstImage)
                .then(({ filename }) => {
                    load_status.status = `Saved to ${filename}`
                    console.log('Saved to', filename); // saved to /path/to/dest/image.jpg
                })
                .catch((err) => {
                    load_status.status = 'First image download error. Checking media directory...'
                    console.log('first image download error:')
                    console.error(err)
                    globalEvents.emit('reset_media_dir')
                });
        }
        if (dlSecondImage){
            await download.image(optionsSecondImage)
                .then(({ filename }) => {
                    load_status.status = `Saved to ${filename}`
                    console.log('Saved to', filename); // saved to /path/to/dest/image.jpg
                })
                .catch((err) => {
                    load_status.status = 'Second image download error. Checking media directory...'
                    console.log('second image download error:')
                    console.error(err)
                    globalEvents.emit('reset_media_dir')
                });
        }
        
        // Retry download if md5 doesn't match?
        // while(md5File.sync(app.getAppPath() + "/" + global.appMediaDir + "/" + firstImage) != firstImageMd5){
        //     await download.image(optionsFirstImage);
        // }
        
        // console.log(md5File.sync(app.getAppPath() + "/" + global.appMediaDir + "/" + firstImage));
    }
}

function saveSlideShowToCache(url){
    load_status.status = "Caching slides..."
    let options = {
        urls: [url],
        directory: temporal_cache
    }
    scrape(options).then((result) => {
        // Link downloaded media to cached slides
        if(fs.existsSync(cache_dir)){
            fs.rm(cache_dir, { recursive: true }, err => {
                if (err) {
                  throw err
                }
                fs.rename(temporal_cache, cache_dir, err => {
                    if(err){
                        throw err
                    }
                    if(fs.existsSync(path.join(cache_dir,'index.html'))){
                        load_status.status = "Setting up cached slides..."
                        fs.readdir(global.appMediaDir, (error, files) => {
                            console.log('==> FETCHING SAVED MEDIA: saveSlideShowToCache')
                            if (error) console.log(error)
                            // Filter files and get only mp4 files into video_files array
                            let video_files = []
                            let png_files = []
                            files.forEach( file => {
                                console.log(path.extname(file))
                                if(path.extname(file)==='.mp4'){
                                    video_files.push(file)
                                }else if(path.extname(file)==='.png'){
                                    png_files.push(file)
                                }
                            })
                            
                            // Read the index.html and get the HTML content as data
                            fs.readFile(path.join(cache_dir,'index.html'),'utf8', (err,data)=>{
                                console.log('==> CHANGING MEDIA SOURCE TO CACHE: saveSlideShowToCache')
                                if(err){
                                    console.log(err)
                                }
                                
                                // Use regex to match video tags with src attribute
                                const videoTags = data?.match(/<video [^>]*src="[^"]*"[^>]*>/gm)
                                
                                // Loop through all matches and replace the src attribute with the url of downloaded files in global.appMediaDir
                                let newHTML = data
                                videoTags?.forEach((tag,i)=>{
                                    let newTag = tag.replace(/src="([^"]*)".*/, `src='${path.join(global.appMediaDir,video_files[i] ? video_files[i] : '#')}'>`)
                                    newTag = newTag.replace(/poster=([^"]*).*(?=[\""])/gi,`poster='${path.join(global.appMediaDir,png_files[i] ? png_files[i] : '#')}'`)
                                    newHTML = newHTML.replace(tag,newTag)
                                })
                                
                                // Rewrite new HTML into the index.html
                                fs.writeFile(path.join(cache_dir,'index.html'),newHTML,(err)=>{
                                    console.log('==> UPDATING HTML: saveSlideShowToCache')
                                    if(err){
                                        console.log('Failed to rewrite index.html')
                                    }else{
                                        console.log('Slides saved successfully')
                                        globalEvents.emit('cache_saved')
                                    }
                                })
                            })
                        })
                    }else{
                        load_status.status = "Slides not downloaded. Reloading..."
                        console.log('slides not downloaded')
                        globalEvents.emit('media_deleted')
                    }
                })
            })
        }else{            
            fs.rename(temporal_cache, cache_dir, err => {
                if(err){
                    throw err
                }
                if(fs.existsSync(path.join(cache_dir,'index.html'))){
                    load_status.status = "Setting up cached slides..."
                    console.log('==> HTML DOWNLOADED: saveSlideShowToCache')
                    fs.readdir(global.appMediaDir, (error, files) => {
                        console.log('==> FETCHING SAVED MEDIA: saveSlideShowToCache')
                        if (error) console.log(error)
                        // Filter files and get only mp4 files into video_files array
                        let video_files = []
                        let png_files = []
                        files.forEach( file => {
                            console.log(path.extname(file))
                            if(path.extname(file)==='.mp4'){
                                video_files.push(file)
                            }else if(path.extname(file)==='.png'){
                                png_files.push(file)
                            }
                        })
                        
                        // Read the index.html and get the HTML content as data
                        fs.readFile(path.join(cache_dir,'index.html'),'utf8', (err,data)=>{
                            console.log('==> CHANGING MEDIA SOURCE TO CACHE: saveSlideShowToCache')
                            if(err){
                                console.log(err)
                            }
                            
                            // Use regex to match video tags with src attribute
                            const videoTags = data?.match(/<video [^>]*src="[^"]*"[^>]*>/gm)
                            
                            // Loop through all matches and replace the src attribute with the url of downloaded files in global.appMediaDir
                            let newHTML = data
                            videoTags?.forEach((tag,i)=>{
                                let newTag = tag.replace(/src="([^"]*)".*/, `src='${path.join(global.appMediaDir,video_files[i] ? video_files[i] : '#')}'>`)
                                newTag = newTag.replace(/poster=([^"]*).*(?=[\""])/gi,`poster='${path.join(global.appMediaDir,png_files[i] ? png_files[i] : '#')}'`)
                                newHTML = newHTML.replace(tag,newTag)
                            })
                            
                            // Rewrite new HTML into the index.html
                            fs.writeFile(path.join(cache_dir,'index.html'),newHTML,(err)=>{
                                console.log('==> UPDATING HTML: saveSlideShowToCache')
                                if(err){
                                    console.log('Failed to rewrite index.html')
                                }else{
                                    load_status.status = "Slides saved successfully"
                                    console.log('Slides saved successfully')
                                    globalEvents.emit('cache_saved')
                                }
                            })
                        })
                    })
                }else{
                    load_status.status = "Slides not downloaded. Reloading..."
                    console.log('slides not downloaded')
                    globalEvents.emit('media_deleted')
                }
            })
        }
    }).catch((err) => {
        console.log("An error ocurred", err);
        fs.rm(temporal_cache, { recursive: true }, err => {
            if (err) {
              throw err
            }
            load_status.status = "Failed to save slides. Refetching..."
            console.log('Cache emptied to get new slides')
            saveSlideShowToCache(url)
        })
          
    });  
}

// Checks if cache exists
// If exists, load page from cache
function runSlidesFromCache(cache){
    console.log('loading slides from cache')
    try {
        const mediaFiles = fs.readdirSync(global.appMediaDir)
        if(fs.existsSync(cache) && fs.existsSync(global.appMediaDir) && mediaFiles.length > 0){
            console.log('slides and media exist')
            win.loadFile(cache)
        }else if(win.webContents.getURL() !== url.pathToFileURL(path.join(__dirname, 'loading.html')).href){
            win.loadFile(path.join(__dirname, 'loading.html'));
        }   
    } catch (error) {
        console.log('Failed to load slides from cache', error)
        globalEvents.emit('media_deleted')
    }
}

// Calculate directory size
async function dirSize(dir){
    let files
    try {
        files = await readdir( dir, { withFileTypes: true } );
    } catch (error) {
        console.log('file does not exist. refetching...', error)
        globalEvents.emit('reset_media_dir')
    }
    if(files){
        const paths = files.map( async file => {
          const fPath = path.join( dir, file.name );
          if ( file.isDirectory() ) return await dirSize( fPath );
          if ( file.isFile() ) {
            const { size } = await stat( fPath );
            return size;
          }
          return 0;
        } );
        return ( await Promise.all( paths ) ).flat( Infinity ).reduce( ( i, size ) => i + size, 0 );
    }
}

// check for total directory size. Should be under 10GB
// clear directory if greater than 10GB
async function keepMediaDirUnder10GB(){
    const size = await dirSize(global.appMediaDir);
    const saved_cache = path.join(__dirname,'cached_slideshow.site')
    console.log(size/1024/1024)
    if ((size/1024/1024/1024) > 10){
        globalEvents.emit('media_deleted')
        console.log('Media directory size exceeds 10 GB')
        console.log('Clearing media directory')
        fse.emptyDirSync(global.appMediaDir + "/")
        if(fs.existsSync(saved_cache)){
            fse.emptyDirSync(saved_cache + "/")
        }

        // Trigger update playlist status to download files again
        global.appModifiedOn = 0
    }
}