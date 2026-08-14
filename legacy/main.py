from PIL import Image
import PIL
import os
import glob
import tkinter
from tkinter import filedialog, messagebox, HORIZONTAL


def compress_images(directory=False, quality=30):
    # 1. If there is a directory then change into it, else perform the next operations inside of the
    # current working directory:
    if directory:
        os.chdir(directory)

    # 2. Extract all of the .png and .jpeg files:
    files = os.listdir()

    # 3. Extract all of the images:
    images = [file for file in files if file.endswith(
        ('jpg', 'png', 'JPG', 'jpeg'))]

    # 4. Loop over every image:
    for image in images:
        print(image)

        # 5. Open every image:
        img = Image.open(image)

        # 5. Compress every image and save it with a new name:
        img.save(
                 "Compressed" + image , optimize=True, quality=quality)


# Create the Tkinter interface.
app = tkinter.Tk()
app.geometry('355x225')
app.title("Robert's Magic Image Compressor")

# Open the file picker and send the selected files to the count() function.


def clicked():
    t = tkinter.filedialog.askdirectory()
    compress_images(t, quality.get())
    print(quality.get())


# Create the window header.
header = tkinter.Label(app, text="Welcome to Robert's Mass Compressor! \n Please keep your hands and feet \n inside the vehicle at all times",
                       fg="#4d1978", font=("Arial Bold", 16))
header.pack(side="top", ipady=10)

# Add the descriptive text.
text = tkinter.Label(
    app, text="Select quality and the folder, and then\n computer gremlins will optimize them")
text.pack()

quality = tkinter.Scale(app, from_=30, to=70, length=400,
                        tickinterval=10, orient="horizontal")
quality.pack()
print(quality.get())
# Draw the button that opens the file picker.
open_files = tkinter.Button(app, text="Choose folder", command=clicked)
open_files.pack(fill="x")

# Initialize Tk window.
app.mainloop()
